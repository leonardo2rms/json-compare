export const SAMPLE_LEFT = JSON.stringify(
  {
    name: 'json-compare',
    version: '1.0.0',
    private: true,
    tags: ['json', 'diff', 'tool'],
    settings: { theme: 'light', fontSize: 13, autosave: true },
    users: [
      { id: 1, name: 'Ada', roles: ['admin'] },
      { id: 2, name: 'Linus', roles: ['dev'] },
      { id: 3, name: 'Grace', roles: ['dev', 'ops'] },
    ],
  },
  null,
  2,
);

export const SAMPLE_RIGHT = JSON.stringify(
  {
    name: 'json-compare',
    version: '1.1.0',
    private: true,
    tags: ['json', 'diff', 'tool', 'fast'],
    settings: { theme: 'dark', fontSize: 13, autosave: true },
    users: [
      { id: 1, name: 'Ada', roles: ['admin'] },
      { id: 3, name: 'Grace', roles: ['dev', 'ops', 'lead'] },
      { id: 4, name: 'Alan', roles: ['research'] },
    ],
  },
  null,
  2,
);
