import { createOpenAI } from '@ai-sdk/openai';

/**
 * Verified against /v1/models on 2026-07-30: this account's key serves up to
 * gpt-4.1. build-notes 4.4 says gpt-5, which does not exist here.
 */
export const SIGNET_MODEL_ID = process.env.SIGNET_MODEL_ID ?? 'gpt-4.1';

export function signetModel() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — see .env.example');
  }
  return createOpenAI({ apiKey })(SIGNET_MODEL_ID);
}
