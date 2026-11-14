// Athena HPC bridge: the SSH host keys pinned in this build (F05 slice 06).
//
// The login host's key below was recorded on 2026-11-13 from the owner's known_hosts (F05 slice 01), fingerprint
// `SHA256:FJ3J1rGZ1+eFtI8vkGwfITtOQ1sBZ1zCh1Bd90p4yU8`. It still awaits comparison with what HPC support publishes.
// The bridge never trusts a host on first use: a host missing from this table, or with an empty list, is never
// contacted and reported as `host_key_unknown`; a host that presents another key is refused (`host_key_mismatch`).
//
// To record a key, from a machine that already trusts the login host (compare with what HPC support publishes):
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
  'login5.ccm.sickkids.ca': Object.freeze([
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOvnKoIWRHAHFf1RQ8PEp64R3uqYWqVNIBoDhR45WtY1'
  ])
})
