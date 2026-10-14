export interface GroupContextLine { senderId: string; text: string; at: number }

/** Conservative direct-address detection; ambiguous/quoted/third-person mentions stay quiet. */
export function addressedByName(text: string): boolean {
  if (/[“”「」『』"]/.test(text) || /(?:他说|她说|转发|引用|听说|据说)/.test(text)) return false
  return /^(?:喂[，,\s]*)?(?:苏沐薇|沐薇|小薇)[，,:：\s]+\S/.test(text.trim())
    || /^(?:苏沐薇|沐薇|小薇)(?:在吗|你好|你(?:能|会|觉得|认为|可以|有没有|要不要|知道)|帮我|请)/.test(text.trim())
}

export class GroupContextBuffer {
  private readonly rooms = new Map<string, GroupContextLine[]>()
  add(groupId: string, line: GroupContextLine): void {
    const lines = this.read(groupId, line.at)
    lines.push({ ...line, text: line.text.slice(0, 1000) })
    while (lines.length > 20 || lines.reduce((sum, item) => sum + item.text.length, 0) > 6000) lines.shift()
    this.rooms.delete(groupId)
    this.rooms.set(groupId, lines)
    while (this.rooms.size > 32) this.rooms.delete(this.rooms.keys().next().value!)
  }
  read(groupId: string, now = Date.now()): GroupContextLine[] {
    const lines = (this.rooms.get(groupId) ?? []).filter(line => line.at >= now - 300_000 && line.at <= now)
    if (lines.length === 0) this.rooms.delete(groupId)
    return lines.map(line => ({ ...line }))
  }
  clear(groupId: string): void { this.rooms.delete(groupId) }
}
