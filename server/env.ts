// Imported first so .env values (GITHUB_TOKEN, PORT) exist before other modules read process.env.
try {
  process.loadEnvFile()
} catch {}
