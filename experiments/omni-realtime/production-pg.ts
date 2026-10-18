import { execFileSync } from 'node:child_process'

export const PRODUCTION_CONTAINER = 'lg-postgresql-production'
export const PRODUCTION_VOLUME = 'lg-postgresql-production-20261014'

export function assertProductionPostgres(target: string): void {
  const url = new URL(target)
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/sumuwei') throw new Error('native_voice_production_target_rejected')
  const ids = execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8', windowsHide: true }).trim().split(/\s+/).filter(Boolean)
  const containers = JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8', windowsHide: true })) as Array<{
    Name: string; State: { Running: boolean }; Mounts: Array<{ Destination: string; Name: string; RW: boolean }>;
    HostConfig: { PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> }
  }>
  const instance = containers.find(x => x.Name === `/${PRODUCTION_CONTAINER}`)
  const bindings = instance?.HostConfig.PortBindings['5432/tcp']
  const holders = containers.filter(x => x.State.Running && x.Mounts.some(m => m.Name === PRODUCTION_VOLUME))
  if (!instance?.State.Running || holders.length !== 1 || holders[0] !== instance ||
      !instance.Mounts.some(m => m.Destination === '/var/lib/postgresql/data' && m.Name === PRODUCTION_VOLUME && m.RW) ||
      !bindings?.length || !bindings.every(b => b.HostIp === '127.0.0.1' && b.HostPort === '55432')) throw new Error('native_voice_actual_production_mount_rejected')
}
