export type SessionOrigin = 'local' | 'remote'

export interface SessionOriginInfo {
  origin: SessionOrigin
  remote_addr: string | null
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return true
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  )
}

export function classifyPeerAddress(address: string | null | undefined): SessionOriginInfo {
  if (isLoopbackAddress(address)) {
    return { origin: 'local', remote_addr: null }
  }
  return { origin: 'remote', remote_addr: address ?? null }
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || isLoopbackAddress(host)
}
