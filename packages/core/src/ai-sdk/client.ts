/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateText,
  streamText,
  type LanguageModel,
  type CoreMessage,
  type FinishReason,
  type ToolChoice,
  type Tool,
} from 'ai';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  Content,
  Part,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Candidate,
  ContentListUnion,
  FinishReason as GoogleFinishReason,
} from '@google/genai';
import { ContentGenerator } from '../core/contentGenerator.js';

export interface AISDKConfig {
  model: LanguageModel;
  defaultModelName: string;
}

export class AISDKModelsClient implements ContentGenerator {
  constructor(private config: AISDKConfig) {}

  async generateContent(
    params: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const aiSdkParams = this.convertToAISDKParams(params);
    
    try {
      const result = await generateText(aiSdkParams);
      return this.convertToGoogleGenAIResponse(result, params.model);
    } catch (error) {
      throw new Error(`AI SDK generateText failed: ${error}`);
    }
  }

  async generateContentStream(
    params: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const aiSdkParams = this.convertToAISDKParams(params);
    
    try {
      const result = await streamText(aiSdkParams);
      return this.convertStreamToGoogleGenAI(result, params.model);
    } catch (error) {
      throw new Error(`AI SDK streamText failed: ${error}`);
    }
  }

  async countTokens(params: CountTokensParameters): Promise<CountTokensResponse> {
    // For now, implement a basic token counting estimation
    // TODO: Use AI SDK's token counting when available
    const normalizedContents = this.normalizeContents(params.contents);
    const text = this.extractTextFromContents(normalizedContents);
    const estimatedTokens = Math.ceil(text.length / 4); // rough estimation
    
    return {
      totalTokens: estimatedTokens,
    };
  }

  async embedContent(
    _params: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // TODO: Implement using AI SDK embedding capabilities
    throw new Error('Embedding not yet implemented for AI SDK client');
  }

  // Type conversion utilities
  private convertToAISDKParams(params: GenerateContentParameters) {
    const normalizedContents = this.normalizeContents(params.contents);
    const messages = this.convertContentsToMessages(normalizedContents);
    const config = params.config || {};
    
    return {
      model: this.config.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      topP: config.topP,
      tools: this.convertToolsToAISDK(config.tools),
      system: this.extractSystemMessage(normalizedContents),
    };
  }

  private convertToGoogleGenAIResponse(result: any, model?: string): GenerateContentResponse {
    const candidate: Candidate = {
      content: {
        role: 'model',
        parts: [{ text: result.text }],
      },
      finishReason: this.convertFinishReason(result.finishReason),
      index: 0,
    };

    const usage: GenerateContentResponseUsageMetadata = {
      promptTokenCount: result.usage?.promptTokens || 0,
      candidatesTokenCount: result.usage?.completionTokens || 0,
      totalTokenCount: result.usage?.totalTokens || 0,
      cachedContentTokenCount: result.providerMetadata?.anthropic?.cacheReadInputTokens,
    };

    const response = new GenerateContentResponse();
    response.candidates = [candidate];
    response.usageMetadata = usage;
    response.modelVersion = model || this.config.defaultModelName;
    return response;
  }

  private async *convertStreamToGoogleGenAI(
    stream: any,
    model?: string,
  ): AsyncGenerator<GenerateContentResponse> {
    let accumulatedText = '';
    
    for await (const chunk of stream.textStream) {
      accumulatedText += chunk;
      
      const candidate: Candidate = {
        content: {
          role: 'model',
          parts: [{ text: chunk }],
        },
        finishReason: undefined, // Not finished yet
        index: 0,
      };

      const response = new GenerateContentResponse();
      response.candidates = [candidate];
      response.modelVersion = model || this.config.defaultModelName;
      yield response;
    }

    // Final chunk with finish reason and usage
    const finalUsage = await stream.usage;
    const finalFinishReason = await stream.finishReason;
    const finalProviderMetadata = await stream.providerMetadata;
    
    const finalCandidate: Candidate = {
      content: {
        role: 'model',
        parts: [{ text: '' }], // Empty text for final chunk
      },
      finishReason: this.convertFinishReason(finalFinishReason),
      index: 0,
    };

    const usage: GenerateContentResponseUsageMetadata = {
      promptTokenCount: finalUsage?.promptTokens || 0,
      candidatesTokenCount: finalUsage?.completionTokens || 0,
      totalTokenCount: finalUsage?.totalTokens || 0,
      cachedContentTokenCount: finalProviderMetadata?.anthropic?.cacheReadInputTokens,
    };

    const finalResponse = new GenerateContentResponse();
    finalResponse.candidates = [finalCandidate];
    finalResponse.usageMetadata = usage;
    finalResponse.modelVersion = model || this.config.defaultModelName;
    yield finalResponse;
  }

  private normalizeContents(contents: ContentListUnion): Content[] {
    if (Array.isArray(contents)) {
      // it's a Content[] or a PartsUnion[]
      return contents.map(this.normalizeContent);
    }
    // it's a Content or a PartsUnion
    return [this.normalizeContent(contents)];
  }

  private normalizeContent(content: any): Content {
    if (Array.isArray(content)) {
      // it's a PartsUnion[]
      return {
        role: 'user',
        parts: content.map(part => typeof part === 'string' ? { text: part } : part),
      };
    }
    if (typeof content === 'string') {
      // it's a string
      return {
        role: 'user',
        parts: [{ text: content }],
      };
    }
    if ('parts' in content) {
      // it's a Content
      return content;
    }
    // it's a Part
    return {
      role: 'user',
      parts: [content as Part],
    };
  }

  private convertContentsToMessages(contents: Content[]): CoreMessage[] {
    const messages: CoreMessage[] = [];
    
    for (const content of contents) {
      if (content.role === 'system') {
        // System messages are handled separately
        continue;
      }
      
      const text = content.parts
        ?.map(part => part.text)
        .filter(Boolean)
        .join('') || '';
      
      if (text) {
        messages.push({
          role: content.role === 'user' ? 'user' : 'assistant',
          content: text,
        });
      }
    }
    
    return messages;
  }

  private extractSystemMessage(contents: Content[]): string | undefined {
    const systemContent = contents.find(c => c.role === 'system');
    if (systemContent) {
      return systemContent.parts
        ?.map(part => part.text)
        .filter(Boolean)
        .join('');
    }
    return undefined;
  }

  private extractTextFromContents(contents: Content[]): string {
    return contents
      .flatMap(content => content.parts || [])
      .map(part => part.text)
      .filter(Boolean)
      .join(' ');
  }

  private convertFinishReason(reason: FinishReason | undefined): GoogleFinishReason | undefined {
    switch (reason) {
      case 'stop':
        return GoogleFinishReason.STOP;
      case 'length':
        return GoogleFinishReason.MAX_TOKENS;
      case 'content-filter':
        return GoogleFinishReason.SAFETY;
      case 'tool-calls':
        return GoogleFinishReason.STOP; // Google GenAI doesn't have separate tool-calls finish reason
      case 'error':
        return GoogleFinishReason.OTHER;
      case 'other':
        return GoogleFinishReason.OTHER;
      default:
        return undefined; // Not finished yet or unknown
    }
  }

  private convertToolsToAISDK(tools: any): Record<string, Tool> | undefined {
    // TODO: Implement tool conversion when needed
    return undefined;
  }

  private convertToolChoice(mode: string | undefined): ToolChoice<any> | undefined {
    // TODO: Implement tool choice conversion when needed
    return undefined;
  }
}