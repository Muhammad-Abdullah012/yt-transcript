export interface TranscriptSegment {
  timestamp: string;
  text: string;
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
