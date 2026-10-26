// Read-only startup probe in the serversim Linux image. Never sends QQ messages.
const readings = []
for (const [name, url] of [
  ['llbot-webui', 'http://llbot:3080/'],
  ['pmhq-health', 'http://pmhq:13000/health'],
]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const reading = { name, httpStatus: response.status, reachable: response.ok }
    if (name === 'pmhq-health' && response.ok) {
      const health = await response.json()
      reading.identityPresent = Boolean(health.uin && health.uid)
      reading.qqVersion = health.qq_full_version ?? null
    } else {
      await response.body?.cancel()
    }
    readings.push(reading)
  } catch {
    readings.push({ name, reachable: false })
  }
}
const ready = readings.every(reading => reading.reachable) &&
  readings.some(reading => reading.identityPresent === true)
console.log(JSON.stringify({
  scope: 'isolated LLBot PMHQ startup, serversim Linux image',
  observedAt: new Date().toISOString(),
  node: process.version,
  status: ready ? 'STARTUP_READY' : 'NOT_READY',
  readings,
  realMessageDelivery: 'NOT RUN',
  longTermStability: 'NOT RUN',
  databaseUsed: false,
  modelUsed: false,
}, null, 2))
if (!ready) process.exitCode = 1
