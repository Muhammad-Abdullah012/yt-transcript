// Helper function to encode AudioBuffer to WAV Blob
// Based on: https://github.com/mattdiamond/Recorderjs/blob/master/src/recorderWorker.js (exportWAV logic)
// and https://docs.fileformat.com/audio/wav/
export const audioBufferToWav = (buffer: AudioBuffer): Blob => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44; // 2 bytes per sample
  const bufferArr = new ArrayBuffer(length);
  const view = new DataView(bufferArr);
  const channels: Float32Array[] = [];
  let i: number;
  let sample: number;
  let offset = 0;
  let pos = 0;

  // Write WAV container
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  // Write FMT chunk
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this implementation)

  // Write Data chunk
  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // Write the PCM samples
  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (i = 0; i < numOfChan; i++) {
      // Interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][offset])); // Clamp
      // Scale to 16-bit signed int
      sample = 0.5 + sample < 0 ? sample * 32768 : sample * 32767;
      view.setInt16(pos, sample, true); // Write 16-bit sample
      pos += 2;
    }
    offset++; // Next frame
  }

  return new Blob([bufferArr], { type: "audio/wav" });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
};
