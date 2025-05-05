export interface TranscriptSegment {
  timestamp: string;
  text: string;
  startTime?: number;
}

export interface GeminiPart {
  text: string;
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiGenerationConfig {
  temperature: number;
  responseMimeType: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig: GeminiGenerationConfig;
}

export interface GeminiResponse {
  candidates?: { content: GeminiContent }[];
  promptFeedback?: { safetyRatings: any[] };
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

export interface SegmentAudioData {
  index: number;
  text: string;
  audioContent: string; // Base64 encoded audio data (e.g., WAV or MP3)
  startTime: number; // Include start time for convenience
}

export interface SegmentWithStartTime {
  startTime: number;
  [key: string]: any; // Allow other properties
}

export interface SyncStatus {
  state: 'stopped' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';
  message?: string;
  segmentIndex?: number;
  error?: string;
}