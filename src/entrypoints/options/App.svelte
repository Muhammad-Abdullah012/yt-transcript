<script lang="ts">
  import { onMount } from "svelte";
  import { storage } from "#imports";
  import { fade } from "svelte/transition";

  // Define interface for settings
  interface Settings {
    TALKIFY_API_KEY: string;
    TALKIFY_TTS_API_URL: string;
    GEMINI_API_KEY: string;
    GEMINI_API_URL: string;
  }

  // Reactive settings object
  let settings: Settings = {
    TALKIFY_API_KEY: "",
    TALKIFY_TTS_API_URL: "",
    GEMINI_API_KEY: "",
    GEMINI_API_URL: "",
  };

  // Feedback state
  let saveStatus: "idle" | "success" | "error" = "idle";
  let errorMessage = "";

  // Load settings on mount
  onMount(async () => {
    try {
      const keys = Object.keys(settings);
      for (const key of keys) {
        const value = (await storage.getItem<string>(`local:${key}`)) ?? "";
        settings[key as keyof Settings] = value;
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  });

  // Handle save
  async function handleSave() {
    try {
      for (const [key, value] of Object.entries(settings)) {
        await storage.setItem(`local:${key}`, value.trim());
      }
      saveStatus = "success";
      setTimeout(() => (saveStatus = "idle"), 3000);
    } catch (err) {
      console.error("Failed to save settings:", err);
      saveStatus = "error";
      errorMessage = "Failed to save settings. Please try again.";
      setTimeout(() => (saveStatus = "idle"), 3000);
    }
  }
</script>

<div
  class="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center p-4"
>
  <div
    class="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md"
  >
    <h1
      class="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-6 text-center"
    >
      Extension Settings
    </h1>

    <div class="space-y-4">
      <!-- Talkify API Key -->
      <div>
        <label
          for="talkifyApiKey"
          class="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Talkify API Key
        </label>
        <input
          id="talkifyApiKey"
          type="text"
          bind:value={settings.TALKIFY_API_KEY}
          class="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 sm:text-sm"
          placeholder="Enter Talkify API Key"
        />
      </div>

      <!-- Talkify TTS API URL -->
      <div>
        <label
          for="talkifyTtsApiUrl"
          class="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Talkify TTS API URL
        </label>
        <input
          id="talkifyTtsApiUrl"
          type="url"
          bind:value={settings.TALKIFY_TTS_API_URL}
          class="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 sm:text-sm"
          placeholder="Enter Talkify TTS API URL"
        />
      </div>

      <!-- Gemini API Key -->
      <div>
        <label
          for="geminiApiKey"
          class="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Gemini API Key
        </label>
        <input
          id="geminiApiKey"
          type="text"
          bind:value={settings.GEMINI_API_KEY}
          class="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 sm:text-sm"
          placeholder="Enter Gemini API Key"
        />
      </div>

      <!-- Gemini API URL -->
      <div>
        <label
          for="geminiApiUrl"
          class="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Gemini API URL
        </label>
        <input
          id="geminiApiUrl"
          type="url"
          bind:value={settings.GEMINI_API_URL}
          class="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 sm:text-sm"
          placeholder="Enter Gemini API URL"
        />
      </div>
    </div>

    <!-- Save Button -->
    <div class="mt-6 flex justify-end">
      <button
        on:click={handleSave}
        class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 transition-colors"
      >
        Save Settings
      </button>
    </div>

    <!-- Feedback Message -->
    {#if saveStatus === "success"}
      <div
        class="mt-4 text-green-600 dark:text-green-400 text-sm text-center"
        transition:fade
      >
        Settings saved successfully!
      </div>
    {:else if saveStatus === "error"}
      <div
        class="mt-4 text-red-600 dark:text-red-400 text-sm text-center"
        transition:fade
      >
        {errorMessage}
      </div>
    {/if}
  </div>
</div>

<style>
  :global(html) {
    @apply transition-colors duration-200;
  }
</style>
