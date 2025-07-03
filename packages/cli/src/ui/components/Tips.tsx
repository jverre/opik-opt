/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type Config } from '@google/gemini-cli-core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const geminiMdFileCount = config.getGeminiMdFileCount();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={Colors.Foreground}>Tips for getting started:</Text>
      <Text color={Colors.Foreground}>
        1. Ask about prompt engineering best practices
      </Text>
      <Text color={Colors.Foreground}>
        2. Ask Opik to optimize your prompts
      </Text>
      <Text color={Colors.Foreground}>
        3.{' '}
        <Text bold color={Colors.AccentPurple}>
          /help
        </Text>{' '}
        for more information
      </Text>
    </Box>
  );
};
