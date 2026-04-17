const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUtils() {
  return import('../src/js/session-title-utils.mjs');
}

test('resolveSessionDisplayTitle prefers the persisted session title from the messages payload', async () => {
  const { resolveSessionDisplayTitle } = await loadUtils();

  assert.equal(
    resolveSessionDisplayTitle({
      sessionId: '20260417_130445_7613dc',
      data: {
        session: {
          title: 'Syncor IP PR revisions',
        },
      },
    }),
    'Syncor IP PR revisions'
  );
});

test('resolveSessionDisplayTitle falls back to the session id when the persisted title is blank or em dash', async () => {
  const { resolveSessionDisplayTitle } = await loadUtils();

  assert.equal(
    resolveSessionDisplayTitle({
      sessionId: '20260414_075004_676472',
      data: {
        session: {
          title: '—',
        },
      },
    }),
    '20260414_075004_676472'
  );

  assert.equal(
    resolveSessionDisplayTitle({
      sessionId: '20260414_075004_676472',
      data: {
        session: {
          title: '',
        },
      },
    }),
    '20260414_075004_676472'
  );
});
