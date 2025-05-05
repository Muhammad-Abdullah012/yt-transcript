export const ACTION = {
    GET_TRANSCRIPTION: "GET_TRANSCRIPTION",
    TRANSCRIPTION_RESULT: "TRANSCRIPTION_RESULT",
    TRANSCRIPTION_ERROR: "TRANSCRIPTION_ERROR",
    TTS: "TTS",
    START_AUDIO_STREAM: 'START_AUDIO_STREAM',
    REQUEST_SYNC_AUDIO: "REQUEST_SYNC_AUDIO", // Content -> Background: Get all audio for sync
    SYNC_AUDIO_READY: "SYNC_AUDIO_READY", // Background -> Content: All audio data is ready
    SYNC_AUDIO_FAILED: "SYNC_AUDIO_FAILED", // Background -> Content: Error during sync generation

    START_SYNC_PLAYBACK: "START_SYNC_PLAYBACK", // Popup -> Content: User wants to start sync
    STOP_SYNC_PLAYBACK: "STOP_SYNC_PLAYBACK", // Popup -> Content: User wants to stop sync
    SYNC_STATUS_UPDATE: "SYNC_STATUS_UPDATE", // Content -> Popup: Update UI with sync status

    AUDIO_CHUNK: "AUDIO_CHUNK", // Background -> Popup (Port): Send one audio chunk (for progress update)
    STREAM_COMPLETE: "STREAM_COMPLETE", // Background -> Popup (Port): All download chunks generated
    MERGE_PORT_AUDIO: "MERGE_PORT_AUDIO", // Popup -> Background (Port): Request merging of download chunks
    MERGE_AUDIO_RESULT: "MERGE_AUDIO_RESULT", // Background -> Popup (Port): Send merged audio data URL or error

    ERROR: "ERROR", // Background -> Popup (Port): General error during port stream
};

export const TRANSCRIPT_CHECK_INTERVAL = 500; // ms
export const TRANSCRIPT_CHECK_TIMEOUT = 10000; // ms (10 seconds)
