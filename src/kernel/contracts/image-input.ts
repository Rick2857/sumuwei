/** Explicit user attachments, carried separately from conversation text. */
export interface ImageInput { dataUrl: string }
export interface CheckedImageInput extends ImageInput { sourceRef: string }

export const IMAGE_INPUT_LIMITS = {
  maxImages: 4,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxPixels: 20_000_000,
  maxContextImages: 8,
  maxContextBytes: 24 * 1024 * 1024,
} as const

/** Shape/size gate before allocating decoded image bytes. No URLs or local paths. */
export function imageInputShapeError(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > IMAGE_INPUT_LIMITS.maxImages) return 'image_input_count'
  let total = 0
  for (const item of value) {
    if (!item || typeof item.dataUrl !== 'string') return 'image_input_invalid'
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl)
    if (!match || match[2].length % 4 !== 0) return 'image_input_format'
    const size = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
    if (size > IMAGE_INPUT_LIMITS.maxImageBytes) return 'image_input_too_large'
    total += size
  }
  return total > IMAGE_INPUT_LIMITS.maxTotalBytes ? 'image_input_too_large' : undefined
}
