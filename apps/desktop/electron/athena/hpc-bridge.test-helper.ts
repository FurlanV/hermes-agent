// Test helper (F05 slice 06): a stand-in HPC on loopback. A login node (an in-process SSH server that accepts one
// public key and forwards `direct-tcpip` channels) and, behind it, a model server (a small OpenAI-shaped HTTP
// server). Nothing here leaves 127.0.0.1, and no real host is ever named in a connection.

import { timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer
} from 'node:net'

import { type Connection, Server as SshServer, utils } from 'ssh2'

export interface KeyPair {
  private: string
  public: string
}

/**
 * A fresh ed25519 key pair. ssh2's own generator now and then (about 1 in 250) writes a pair that ssh2 cannot parse
 * back ("Malformed OpenSSH private key"), so a pair is only handed out once both halves parse.
 */
export function newKeyPair(): KeyPair {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519')

    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
      return pair
    }
  }
}

/** The key line of a public key as `known_hosts` has it, without a comment: `ssh-ed25519 AAAA…`. */
export const keyLine = (publicKey: string): string => publicKey.trim().split(/\s+/).slice(0, 2).join(' ')

function parsed(publicKey: string) {
  const key = utils.parseKey(publicKey)

  if (key instanceof Error) {
    throw key
  }

  return key
}

// ── The model server ────────────────────────────────────────────────────────

export interface ModelServer {
  /** The `Authorization` header of every request that arrived, accepted or not, in order. */
  authorizations: string[]
  close: () => Promise<void>
  port: number
  /** Each request it answered: method, path and the parsed JSON body. */
  requests: { body: unknown; method: string; path: string }[]
}

/**
 * A stand-in model server. With `key` it takes an API key, as a keyed model server does (F05 slice 12): a request
 * without `Authorization: Bearer <key>` gets 401 and is not counted in `requests`.
 */
export async function startModelServer(
  answer = 'from the model node',
  options: { key?: string } = {}
): Promise<ModelServer> {
  const requests: ModelServer['requests'] = []
  const authorizations: string[] = []

  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null

      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }

      authorizations.push(request.headers.authorization ?? '')
      response.setHeader('content-type', 'application/json')

      if (options.key !== undefined && request.headers.authorization !== `Bearer ${options.key}`) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'invalid_api_key' } }))

        return
      }

      requests.push({ body, method: request.method ?? '', path: request.url ?? '' })
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', index: 0, message: { content: answer, role: 'assistant' } }],
          model: (body as { model?: string } | null)?.model ?? null,
          object: 'chat.completion'
        })
      )
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    authorizations,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    port: (server.address() as AddressInfo).port,
    requests
  }
}

// ── The login node ──────────────────────────────────────────────────────────

export interface LoginNodeOptions {
  /** The public key (OpenSSH line) the node's `authorized_keys` holds. */
  authorizedKey: string
  /** Where a forward to `<host>:<port>` really goes on loopback (null: the node cannot reach it). */
  route: (host: string, port: number) => null | number
}

export interface LoginNode {
  /** Every authentication request received, in order. Empty when a client left before signing in. */
  auth: { method: string; username: string }[]
  close: () => Promise<void>
  /** TCP connections accepted so far. */
  connections: number
  /** Cut every open connection, as a network drop does. */
  drop: () => void
  /** Every forward a signed-in client asked for. */
  forwards: { host: string; port: number }[]
  hostKey: KeyPair
  /** Stop accepting (and cut what is open), as when the login host cannot be reached; `listen` brings it back. */
  goAway: () => Promise<void>
  listen: () => Promise<void>
  port: number
  /** Stop answering without closing anything: what a link that died silently looks like. */
  stall: () => void
}

export async function startLoginNode(options: LoginNodeOptions): Promise<LoginNode> {
  const hostKey = newKeyPair()
  const authorized = parsed(options.authorizedKey)
  const authorizedBlob = authorized.getPublicSSH()
  const sockets = new Set<Socket>()

  const ssh = new SshServer({ hostKeys: [hostKey.private] }, (client: Connection) => {
    client.on('error', () => {})
    client.on('authentication', context => {
      node.auth.push({ method: context.method, username: context.username })

      if (context.method !== 'publickey') {
        context.reject(['publickey'])

        return
      }

      const sameKey =
        context.key.algo === authorized.type &&
        context.key.data.length === authorizedBlob.length &&
        timingSafeEqual(context.key.data, authorizedBlob)

      if (
        !sameKey ||
        (context.signature && authorized.verify(context.blob!, context.signature, context.hashAlgo) !== true)
      ) {
        context.reject(['publickey'])

        return
      }

      context.accept()
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        node.forwards.push({ host: info.destIP, port: info.destPort })
        const port = options.route(info.destIP, info.destPort)

        if (port === null) {
          reject()

          return
        }

        const upstream = connect(port, '127.0.0.1')
        upstream.once('error', () => reject())
        upstream.once('connect', () => {
          upstream.removeAllListeners('error')
          upstream.on('error', () => {})
          const channel = accept()
          channel.on('error', () => {})
          channel.once('close', () => upstream.destroy())
          upstream.once('close', () => channel.end())
          channel.pipe(upstream).pipe(channel)
        })
      })
      // A restricted key gets no shell: only forwards are served here.
      client.on('session', (_accept, reject) => reject())
    })
  })

  let tcp: TcpServer | null = null

  const node: LoginNode = {
    auth: [],
    close: async () => {
      await node.goAway()
      ssh.close()
    },
    connections: 0,
    drop: () => {
      for (const socket of sockets) {
        socket.destroy()
      }
    },
    forwards: [],
    goAway: async () => {
      const server = tcp
      tcp = null
      node.drop()

      if (server) {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    },
    hostKey,
    listen: async () => {
      const server = createTcpServer(socket => {
        node.connections += 1
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        ssh.injectSocket(socket)
      })

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(node.port, '127.0.0.1', () => resolve())
      })
      node.port = (server.address() as AddressInfo).port
      tcp = server
    },
    port: 0,
    stall: () => {
      for (const socket of sockets) {
        socket.pause()
        socket.write = () => true
      }
    }
  }

  await node.listen()

  return node
}

// ── Calling through the forward ─────────────────────────────────────────────

/**
 * One chat completion against `http://<host>:<port>/v1`, as hermes sends one. `bearer` is the provider's key:
 * hermes's placeholder for a provider without one, unless given.
 */
export function chat(
  port: number,
  model: string,
  host = '127.0.0.1',
  bearer = 'no-key-required'
): Promise<{ body: any; status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ messages: [{ content: 'Say hello.', role: 'user' }], model })

    const request = httpRequest(
      {
        agent: false,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        host,
        method: 'POST',
        path: '/v1/chat/completions',
        port,
        timeout: 5000
      },
      response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk as Buffer))
        response.on('end', () => {
          try {
            resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), status: response.statusCode ?? 0 })
          } catch (error) {
            reject(error as Error)
          }
        })
      }
    )

    request.on('timeout', () => request.destroy(new Error('timed out')))
    request.on('error', reject)
    request.end(payload)
  })
}
