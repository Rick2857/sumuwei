/** Installed only by the isolated native-voice entry; normal CLI/QQ keep their provider. */
export interface NativeVoiceRequest {
  prompt: string
  replyId: string
  traceId: string
  signal?: AbortSignal
}

export interface NativeVoiceReplyPort {
  readonly model: string
  generate(input: NativeVoiceRequest): Promise<{ text: string; durationMs: number }>
  correct(input: NativeVoiceRequest & { checkedText: string }): Promise<{ text: string }>
}

let installed: NativeVoiceReplyPort | undefined

export function installNativeVoiceReplyPort(port: NativeVoiceReplyPort): () => void {
  if (installed !== undefined) throw new Error('native_voice_port_already_installed')
  installed = port
  return () => { if (installed === port) installed = undefined }
}

export function nativeVoiceReplyPortFor(entry: string): NativeVoiceReplyPort | undefined {
  return entry === 'avatar' ? installed : undefined
}
