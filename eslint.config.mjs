import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/.git/**',
      'research/**', 'docs/**', '**/*.cjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // 施工文档 §55 Rule 8：禁止吞异常
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 研究报告 R8：禁止散落的字符串枚举 —— 用 no-restricted-syntax 提示明显的魔法字符串
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^evt-/]",
          message: '事件 ID 请使用 @nwa/core 的 eventId()，不要手写。',
        },
      ],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // 测试文件放宽
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
