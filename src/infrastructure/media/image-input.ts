import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { KernelError } from '../../kernel/contracts/ids.ts'
import { IMAGE_INPUT_LIMITS, imageInputShapeError, type ImageInput, type CheckedImageInput } from '../../kernel/contracts/image-input.ts'
import { detectImageFormat, validateImageBytes } from '../action/adapters/image-ocr.ts'

/** Content-addressed originals live inside the same snapshot/isolated-data boundary as the ledger. */
export class ImageInputStore {
  constructor(private readonly dataDir: string) {}
  private path(ref: string): string {
    if (!/^image:sha256:[a-f0-9]{64}$/.test(ref)) throw new Error('image_ref_invalid')
    return join(this.dataDir, 'image-inputs', `${ref.slice('image:sha256:'.length)}.bin`)
  }
  async save(images: readonly CheckedImageInput[]): Promise<void> {
    if (!images.length) return
    await mkdir(join(this.dataDir, 'image-inputs'), { recursive: true })
    for (const image of images) {
      if (await this.load(image.sourceRef)) continue
      const path = this.path(image.sourceRef)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, Buffer.from(image.dataUrl.split(',')[1], 'base64'), { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
      } finally { await unlink(temporary).catch(() => undefined) }
    }
  }
  async load(ref: string): Promise<CheckedImageInput | undefined> {
    try {
      const path = this.path(ref)
      const info = await stat(path)
      if (!info.isFile() || info.size > IMAGE_INPUT_LIMITS.maxImageBytes) return undefined
      const bytes = await readFile(path)
      const format = detectImageFormat(bytes)
      const image = checkImageInputs([{ dataUrl: `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}` }])[0]
      return image.sourceRef === ref ? image : undefined
    } catch { return undefined }
  }
}

export function checkImageInputs(images: readonly ImageInput[] | undefined): CheckedImageInput[] {
  const error = imageInputShapeError(images)
  if (error) throw new KernelError('validation_error', error, '图片格式或大小不符合输入范围')
  return (images ?? []).map(image => {
    const [header, encoded] = image.dataUrl.split(',')
    const bytes = Buffer.from(encoded, 'base64')
    const reading = validateImageBytes(bytes, IMAGE_INPUT_LIMITS)
    if (bytes.toString('base64') !== encoded || reading.problems.length !== 0 ||
        header !== `data:image/${reading.format === 'png' ? 'png' : 'jpeg'};base64`) {
      throw new KernelError('validation_error', 'image_input_invalid_bytes', '图片内容损坏、格式不符或尺寸超限')
    }
    return { dataUrl: image.dataUrl, sourceRef: `image:sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  })
}

/** NapCat's ordinary image URL. Never fetch a shell-supplied path or arbitrary host. */
export function qqImageUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('qq_image_url_invalid')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['qpic.cn', 'qq.com', 'qq.com.cn'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('qq_image_url_invalid')
  }
  return url
}

export async function downloadQqImage(value: unknown): Promise<ImageInput> {
  let url = qqImageUrl(value)
  const signal = AbortSignal.timeout(10_000)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || redirect === 3) throw new Error('qq_image_redirect_failed')
      url = qqImageUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('qq_image_download_failed') }
    if (Number(response.headers.get('content-length')) > IMAGE_INPUT_LIMITS.maxImageBytes) {
      await response.body.cancel(); throw new Error('image_input_too_large')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > IMAGE_INPUT_LIMITS.maxImageBytes) throw new Error('image_input_too_large')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const bytes = Buffer.concat(chunks)
    const reading = validateImageBytes(bytes, IMAGE_INPUT_LIMITS)
    if (reading.problems.length !== 0) throw new Error('image_input_invalid_bytes')
    return { dataUrl: `data:image/${reading.format === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}` }
  }
  throw new Error('qq_image_download_failed')
}
