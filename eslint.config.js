import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Node-Kernmodule, die es im Browser-Webview nicht gibt. In @bonbon/core
 * verboten (CLAUDE.md, Struktur).
 */
const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
]

/** Globals, die nur in einer der beiden Laufzeiten existieren. */
const PLATFORM_GLOBALS = [
  'window', 'document', 'navigator', 'location', 'localStorage',
  'sessionStorage', 'indexedDB', 'alert', 'fetch', 'crypto', 'performance',
  'process', 'require', '__dirname', '__filename', 'Buffer', 'global',
]

const DETERMINISM_MESSAGE =
  '@bonbon/core hat keine eigene Quelle fuer Zeit oder Zufall. Zeitstempel und IDs werden ' +
  'hineingereicht — als Parameter oder ueber eine injizierte Clock/IdGenerator. Nur so ist die ' +
  'Bonberechnung deterministisch testbar. Siehe CLAUDE.md, Regel 11.'

const MONEY_MESSAGE =
  'Geldbetraege sind Ganzzahlen in Cent (Typ Cents), kein Fliesskomma. Die Umrechnung nach Euro ' +
  'passiert ausschliesslich in der Darstellungsschicht. Siehe CLAUDE.md, Regel 3.'

const CORE_PURITY_MESSAGE =
  '@bonbon/core muss in jeder JS-Laufzeit laufen (Client-Webview und Node-Backend). ' +
  'Plattformabhaengiges gehoert hinter einen Port in @bonbon/ports. Siehe CLAUDE.md.'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/desktop/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Geldbetraege sind Ganzzahlen in Cent (CLAUDE.md, Regel 3).
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: MONEY_MESSAGE },
      ],
      'no-restricted-globals': ['error', { name: 'parseFloat', message: MONEY_MESSAGE }],
    },
  },

  // --- @bonbon/core: plattformfrei ------------------------------------------
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_BUILTINS.map((name) => ({ name, message: CORE_PURITY_MESSAGE })),
            { name: 'react', message: CORE_PURITY_MESSAGE },
            { name: 'react-dom', message: CORE_PURITY_MESSAGE },
          ],
          patterns: [
            { group: ['node:*'], message: CORE_PURITY_MESSAGE },
            { group: ['react/*', 'react-dom/*'], message: CORE_PURITY_MESSAGE },
            { group: ['@tauri-apps/*'], message: CORE_PURITY_MESSAGE },
            { group: ['@bonbon/ports', '@bonbon/ui', '@bonbon/*'], message: CORE_PURITY_MESSAGE },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: MONEY_MESSAGE },
        ...PLATFORM_GLOBALS.map((name) => ({ name, message: CORE_PURITY_MESSAGE })),
      ],

      // --- Regel 11: keine eigene Quelle fuer Zeit oder Zufall --------------
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: DETERMINISM_MESSAGE },
        { object: 'Math', property: 'random', message: DETERMINISM_MESSAGE },
        { object: 'performance', property: 'now', message: DETERMINISM_MESSAGE },
        { object: 'crypto', property: 'randomUUID', message: DETERMINISM_MESSAGE },
        { object: 'Number', property: 'parseFloat', message: MONEY_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // new Date() ohne Argument liest die Uhr. new Date('2026-08-21T...')
          // ist eine reine Umrechnung und bleibt erlaubt.
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: DETERMINISM_MESSAGE,
        },
        {
          // greift auch, wenn Date/Math ueber einen Alias angesprochen werden.
          selector: "MemberExpression[property.name='random'][object.name='Math']",
          message: DETERMINISM_MESSAGE,
        },
        {
          // toFixed formatiert Euro. Das gehoert in die Darstellungsschicht.
          selector: "CallExpression[callee.property.name='toFixed']",
          message: MONEY_MESSAGE,
        },
      ],
    },
  },

  // --- Konfigurationsdateien ------------------------------------------------
  {
    files: ['*.js', '*.config.ts', '*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
