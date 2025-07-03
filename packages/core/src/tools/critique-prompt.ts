/**
 * @license
 * Copyright 2025 Comet ML
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SchemaValidator } from '../utils/schemaValidator.js';
import { BaseTool, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { getErrorMessage } from '../utils/errors.js';

const CRITIQUE_PROMPT_TEMPLATE = `You are an expert prompt engineer. Please analyze the following prompt and provide feedback on its structure, clarity, effectiveness, and adherence to best practices.{MODEL_PROVIDER_TEXT}

Focus your critique on:
1. **Clarity and Specificity**: Is the prompt clear and unambiguous?
2. **Structure and Organization**: Is the prompt well-organized with proper sections?
3. **Context and Instructions**: Does it provide adequate context and clear instructions?
4. **Output Format**: Does it specify the desired output format?
5. **Edge Cases**: Does it handle potential edge cases or ambiguities?
6. **Best Practices**: Does it follow prompt engineering best practices?

Please provide specific, actionable feedback with examples where appropriate.

**Prompt to critique:**
\`\`\`
{PROMPT_TO_CRITIQUE}
\`\`\`

Provide your critique in a structured format with specific recommendations for improvement.`;

/**
 * Parameters for the CritiquePrompt tool
 */
export interface CritiquePromptToolParams {
  /**
   * The prompt string to critique
   */
  prompt: string;

  /**
   * The model provider this prompt is used with
   */
  modelProvider?: string;
}

/**
 * Implementation of the CritiquePromptTool tool logic
 */
export class CritiquePromptTool extends BaseTool<CritiquePromptToolParams, ToolResult> {
  static readonly Name: string = 'critique_prompt';

  constructor(
    private config: Config,
  ) {
    super(
      CritiquePromptTool.Name,
      'CritiquePrompt',
      'Provides feedback on a given prompt and what it is doing well and not well.',
      {
        properties: {
          prompt: {
            description:
              "The prompt string, this can include variables, placeholders and functions.",
            type: 'string',
          },
          modelProvider: {
            description:
              "The model provider that will consume this prompt, used to tailor the feedback about the prompt",
            type: 'string',
          },
        },
        required: ['prompt'],
        type: 'object',
      },
    );
  }

  validateToolParams(params: CritiquePromptToolParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(
        this.schema.parameters as Record<string, unknown>,
        params,
      )
    ) {
      return 'Parameters failed schema validation.';
    }
    const prompt = params.prompt;

    if (prompt == undefined || prompt.length == 0) {
        return 'prompt must not be empty'
    }
    
    return null;
  }

  async execute(
    params: CritiquePromptToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    const geminiClient = this.config.getGeminiClient();
    
    // Create a structured prompt for critiquing using template
    const modelProviderText = params.modelProvider 
      ? ` The prompt will be used with ${params.modelProvider}.`
      : '';
    
    const critiquePrompt = CRITIQUE_PROMPT_TEMPLATE
      .replace('{MODEL_PROVIDER_TEXT}', modelProviderText)
      .replace('{PROMPT_TO_CRITIQUE}', params.prompt);

    try {
      const response = await geminiClient.generateContent(
        [{ role: 'user', parts: [{ text: critiquePrompt }] }],
        {},
        signal,
      );

      // GenAI SDK requires getResponseText utility
      const responseText = getResponseText(response) || '';
      
      if (!responseText.trim()) {
        return {
          llmContent: 'Error: Empty response from LLM when critiquing prompt.',
          returnDisplay: 'Error: Unable to generate critique for the provided prompt.',
        };
      }

      return {
        llmContent: responseText,
        returnDisplay: `Prompt critique completed. Length: ${params.prompt.length} characters.`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error critiquing prompt: ${errorMessage}`,
        returnDisplay: `Error: Failed to critique prompt - ${errorMessage}`,
      };
    }
  }
}
