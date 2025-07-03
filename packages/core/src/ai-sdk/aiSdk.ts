/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type LanguageModel } from 'ai';
import { ContentGenerator } from '../core/contentGenerator.js';
import { AISDKModelsClient } from './client.js';

export async function createAISDKContentGenerator(
  model: LanguageModel,
  defaultModelName: string,
): Promise<ContentGenerator> {
  return new AISDKModelsClient({
    model,
    defaultModelName,
  });
}