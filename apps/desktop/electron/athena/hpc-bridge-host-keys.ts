// Athena HPC bridge: the SSH host keys pinned in this build (F05 slice 06).
//
// PLACEHOLDER: the login host's real host key is not recorded yet (F05 slice 01 records it). Until its list below
// has an entry the bridge never contacts that host and reports `host_key_unknown`. The bridge never trusts a host
// on first use: a host missing from this table, or with an empty list, is refused.
//
// To fill it in, from a machine that already trusts the login host (compare with what HPC support publishes):
//
//   ssh-keyscan -t ed25519 login5.ccm.sickkids.ca          # the public key line, as in known_hosts
//   ssh-keygen -lf <(ssh-keyscan -t ed25519 login5.ccm.sickkids.ca)   # its SHA256 fingerprint
//
// Each entry is either form:
// - an OpenSSH public key line without the host name: `ssh-ed25519 AAAAC3Nza...` (preferred: the bridge then asks
//   the host for that key type, so a host with several keys answers with the pinned one);
// - a fingerprint: `SHA256:<base64>`, as `ssh-keygen -l` prints it.
// List every key the host may present (and, across a planned key change, the old and the new one).
//
// Keys are the config's `local_models.login_host`, lower case; `<host>:<port>` pins a host on a port other than
// 22 and wins over the bare name.

export type HostKeyPins = Readonly<Record<string, readonly string[]>>

export const HPC_BRIDGE_HOST_KEYS: HostKeyPins = Object.freeze({
  'login5.ccm.sickkids.ca': Object.freeze([])
})
