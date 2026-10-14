import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const PG_CONTAINER = 'lg-omni-isolated-pg'
export const PG_HOST_PORT = '55434'
export function assertIsolatedPostgresState(container: {
  Mounts: { Destination: string; Name?: string; RW: boolean }[]
  HostConfig: { PortBindings?: Record<string, { HostIp: string; HostPort: string }[]> }
  State: { Running: boolean }
}, requireRunning = true): void {
  const data = container.Mounts.filter((mount: { Destination: string }) => mount.Destination === '/var/lib/postgresql/data')
  const bindings = container.HostConfig.PortBindings?.['5432/tcp'] ?? []
  if (container.Mounts.some(mount => mount.Name === 'lg-postgresql-data') || data.length !== 1 || data[0].Name !== 'lg-omni-isolated-data' || !data[0].RW ||
      bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== PG_HOST_PORT ||
      (requireRunning && !container.State.Running)) throw new Error('omni_postgres_actual_mount_or_port_rejected')
}
export function assertIsolatedPostgres(requireRunning = true): void {
  const [container] = JSON.parse(execFileSync('docker', ['inspect', PG_CONTAINER], { encoding: 'utf8', windowsHide: true }))
  assertIsolatedPostgresState(container, requireRunning)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertIsolatedPostgres(!process.argv.includes('--before-start'))
  console.log('PASS: dedicated Omni PostgreSQL volume and loopback port')
}
