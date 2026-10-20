/**
 * WAV framing for raw PCM. A pure leaf, shared by the warmup silence in
 * `voice-service.ts` and the speech-to-text upload, so there is one RIFF header
 * writer in the tree rather than two that disagree about a byte offset.
 */

/** A RIFF/WAVE header for `dataLen` bytes of 16-bit little-endian PCM. */
export function wavHeader(dataLen: number, rate: number, channels: number): Buffer {
  const bytesPerFrame = channels * 2;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * bytesPerFrame, 28); // byte rate
  buf.writeUInt16LE(bytesPerFrame, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Wrap s16le samples in a WAV container. */
export function pcmToWav(pcm: Int16Array, rate: number, channels = 1): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([wavHeader(data.length, rate, channels), data]);
}
