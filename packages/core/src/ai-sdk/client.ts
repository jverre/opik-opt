/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateText,
  streamText,
  jsonSchema,
  type LanguageModel,
  type CoreMessage,
  type FinishReason,
  type Tool,
  type ToolChoice,
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
    
    const aiSdkTools = this.convertToolsToAISDK(config.tools);
    
    const result: any = {
      model: this.config.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      topP: config.topP,
      system: this.extractSystemMessage(normalizedContents),
    };

    // Only add tools and toolChoice if we have tools
    if (aiSdkTools) {
      result.tools = aiSdkTools;
      // Enable tool mode if AFC is not disabled, otherwise explicitly disable
      result.toolChoice = (!config.automaticFunctionCalling?.disable ? 'auto' : 'none') as ToolChoice<typeof aiSdkTools>;
    }

    return result;
  }

  private convertToGoogleGenAIResponse(result: any, model?: string): GenerateContentResponse {
    const parts: Part[] = [];
    const automaticFunctionCallingHistory: Content[] = [];
    
    // Add text content if present
    if (result.text) {
      parts.push({ text: result.text });
    }
    
    // Build automaticFunctionCallingHistory from AI SDK tool execution results
    // This replicates the Code Assist pattern where backend provides this automatically
    if (result.toolCalls && Array.isArray(result.toolCalls)) {
      for (const toolCall of result.toolCalls) {
        // Add model message with function call
        automaticFunctionCallingHistory.push({
          role: 'model',
          parts: [{
            functionCall: {
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              args: toolCall.args || {},
            },
          }],
        });
      }
    }

    if (result.toolResults && Array.isArray(result.toolResults)) {
      for (const toolResult of result.toolResults) {
        // Add user message with function response
        automaticFunctionCallingHistory.push({
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolResult.toolCallId,
              name: toolResult.toolName,
              response: { output: toolResult.result },
            },
          }],
        });
      }
    }
    
    // Default to empty text if no content
    if (parts.length === 0) {
      parts.push({ text: '' });
    }

    const candidate: Candidate = {
      content: {
        role: 'model',
        parts,
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
    
    // Add automaticFunctionCallingHistory like Code Assist does
    if (automaticFunctionCallingHistory.length > 0) {
      response.automaticFunctionCallingHistory = automaticFunctionCallingHistory;
    }
    
    return response;
  }

  private async *convertStreamToGoogleGenAI(
    stream: any,
    model?: string,
  ): AsyncGenerator<GenerateContentResponse> {
    let accumulatedText = '';
    const automaticFunctionCallingHistory: Content[] = [];
    const pendingToolCalls = new Map<string, any>();
    
    // Handle the full stream, not just text
    for await (const chunk of stream.fullStream) {
      const parts: Part[] = [];
      
      // Handle different types of chunks
      if (chunk.type === 'text-delta') {
        accumulatedText += chunk.textDelta;
        parts.push({ text: chunk.textDelta });
      } else if (chunk.type === 'tool-call') {
        const functionCallPart = {
          functionCall: {
            id: chunk.toolCallId,
            name: chunk.toolName,
            args: chunk.args || {},
          },
        };
        
        // Add tool call to visible parts so existing system can see and execute it
        parts.push(functionCallPart);
        
        // Track for automaticFunctionCallingHistory
        pendingToolCalls.set(chunk.toolCallId, {
          functionCall: functionCallPart,
          toolName: chunk.toolName,
        });
        
      } else if (chunk.type === 'tool-result') {
        // AI SDK shouldn't generate tool-result chunks without execute functions
        // If it does, we'll ignore them since the existing system handles execution
        console.log('Unexpected tool-result chunk from AI SDK:', chunk);
        
      } else if (chunk.type === 'error') {
        throw new Error(`Stream error chunk:
  Error message: ${chunk.error?.message || 'No message'}
  Error stack: ${chunk.error?.stack || 'No stack'}
  Full chunk: ${JSON.stringify(chunk, null, 2)}
`);
      } else if (chunk.type === 'step-start') {
        // Skip step-start chunks - they're just metadata
        continue;
      } else {
        // Log unknown chunk types but don't crash
        console.log(`Unknown chunk type: ${chunk.type}`, chunk);
        continue;
      }
      
      // Only yield if we have content
      if (parts.length > 0) {
        const candidate: Candidate = {
          content: {
            role: 'model',
            parts,
          },
          finishReason: undefined, // Not finished yet
          index: 0,
        };

        const response = new GenerateContentResponse();
        response.candidates = [candidate];
        response.modelVersion = model || this.config.defaultModelName;
        
        yield response;
      }
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

    // Build automaticFunctionCallingHistory for any pending tool calls
    // This tells the conversation flow that tools were called and completed
    for (const [toolCallId, pendingCall] of pendingToolCalls) {
      // Add model message with function call
      automaticFunctionCallingHistory.push({
        role: 'model',
        parts: [pendingCall.functionCall],
      });
      
      // Add user message with function response (simulated success)
      automaticFunctionCallingHistory.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id: toolCallId,
            name: pendingCall.toolName,
            response: { output: 'Tool executed by existing system' },
          },
        }],
      });
    }

    const finalResponse = new GenerateContentResponse();
    finalResponse.candidates = [finalCandidate];
    finalResponse.usageMetadata = usage;
    finalResponse.modelVersion = model || this.config.defaultModelName;
    
    // Add automaticFunctionCallingHistory so geminiChat.ts knows tools completed
    if (automaticFunctionCallingHistory.length > 0) {
      finalResponse.automaticFunctionCallingHistory = automaticFunctionCallingHistory;
    }
    
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
      
      // Extract tool calls from model messages
      const toolCalls = content.parts
        ?.filter(part => part.functionCall)
        .map(part => ({
          toolCallId: part.functionCall!.id || `call_${Date.now()}`,
          toolName: part.functionCall!.name!,
          args: part.functionCall!.args || {},
        })) || [];
        
      // Extract tool results from user messages and create separate tool messages
      const toolResults = content.parts
        ?.filter(part => part.functionResponse) || [];
      
      // Add assistant/user messages with text content
      if (text) {
        const contentParts: any[] = [{ type: 'text', text }];
        
        // Add tool calls as ToolCallPart if this is a model message with function calls
        if (content.role === 'model' && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            contentParts.push({
              type: 'tool-call',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              args: toolCall.args,
            });
          }
        }
        
        messages.push({
          role: content.role === 'user' ? 'user' : 'assistant',
          content: contentParts,
        });
      } else if (content.role === 'model' && toolCalls.length > 0) {
        // For model messages with only tool calls (no text)
        const contentParts: any[] = [
          { type: 'text', text: `I'll help you with that. Let me use the appropriate tools.` }
        ];
        
        for (const toolCall of toolCalls) {
          contentParts.push({
            type: 'tool-call',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args: toolCall.args,
          });
        }
        
        messages.push({
          role: 'assistant' as const,
          content: contentParts,
        });
      }
      
      // Add separate tool messages for each tool result
      for (const part of toolResults) {
        const result = part.functionResponse!.response?.output || 'Tool executed';
        messages.push({
          role: 'tool' as const,
          content: [
            {
              type: 'tool-result' as const,
              toolCallId: part.functionResponse!.id!,
              toolName: part.functionResponse!.name!,
              result: typeof result === 'string' ? result : JSON.stringify(result),
            }
          ],
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
    if (!tools || !Array.isArray(tools)) {
      return undefined;
    }

    const convertedTools: Record<string, Tool> = {};

    for (const tool of tools) {
      // Handle Google GenAI Tool format
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        for (const funcDecl of tool.functionDeclarations) {
          if (funcDecl.name) {
            // Convert Google GenAI schema to a format that AI SDK can handle
            const jsonSchemaObj = this.convertGoogleGenAISchemaToJSONSchema(funcDecl.parameters);
            
            const convertedTool = {
              description: funcDecl.description,
              parameters: jsonSchema(jsonSchemaObj),
              // NO execute function - AI SDK will only generate tool-call chunks
              // The existing tool system will handle all execution and provide nice UI
            };
            
            convertedTools[funcDecl.name] = convertedTool;
          }
        }
      }
    }

    return Object.keys(convertedTools).length > 0 ? convertedTools : undefined;
  }

  private convertGoogleGenAISchemaToJSONSchema(schema: any): any {
    if (!schema) {
      return {};
    }
    
    // Google GenAI schemas are already JSON Schema compatible in most cases
    // but we need to ensure they have the right structure for AI SDK
    if (schema.type === 'OBJECT' || schema.type === 'object') {
      return {
        type: 'object',
        properties: schema.properties || {},
        required: schema.required || [],
        additionalProperties: schema.additionalProperties !== false,
      };
    }
    
    // For non-object types, return a simple schema
    return schema.type ? { type: schema.type.toLowerCase() } : {};
  }

}
