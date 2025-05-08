export async function getTalkifyApiKey(): Promise<string | null> {
  return storage.getItem<string>("local:TALKIFY_API_KEY");
}

export async function getTalkifyTtsApiUrl(): Promise<string | null> {
  return storage.getItem<string>("local:TALKIFY_TTS_API_URL");
}

export async function getGeminiApiKey(): Promise<string | null> {
  return storage.getItem<string>("local:GEMINI_API_KEY");
}

export async function getGeminiApiUrl(): Promise<string | null> {
  return storage.getItem<string>("local:GEMINI_API_URL");
}
