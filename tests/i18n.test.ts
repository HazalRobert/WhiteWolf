import assert from 'node:assert/strict';
import test from 'node:test';
import { dictionaries, languages, t } from '../src/i18n';
import type { Language } from '../src/types';

const requiredLanguages = ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar'];
const requiredMessages = [
  'demoBanner', 'connect', 'scan', 'manual', 'automatic', 'autoDescription', 'unknownHelp',
  'whitelistDescription', 'manualConfirmDescription', 'previewDescription', 'pacingHint',
  'freeFooter', 'followAuthor', 'authorDescription', 'authorSelf', 'statusConnected', 'statusDone',
  'statusSkipped', 'statusUnfollowed', 'statusAuthorFollowed', 'statusWhitelistSaved',
  'statusDataCleared', 'statusDemo', 'errorRateLimit', 'errorAuth', 'errorSchema',
  'errorAccountChanged', 'errorNetwork', 'errorUncertain', 'errorWorkerRestart',
  'errorCancelled', 'errorIncomplete', 'errorWhitelist', 'errorBusy', 'errorNotConnected',
  'errorGeneral', 'intent', 'verified', 'skipped', 'uncertain', 'uncertainCount', 'uncertainHelp', 'stopped', 'unconfirmed',
];

const placeholders = (value: string): string[] => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
  .map(match => match[1]).sort();

test('all ten requested locales have labels, complete catalogs and safety messages', () => {
  assert.deepEqual(languages.map(language => language.code), requiredLanguages);
  assert.equal(new Set(languages.map(language => language.code)).size, 10);
  const englishKeys = Object.keys(dictionaries.en).sort();
  for (const { code, label } of languages) {
    assert.ok(label.trim(), `${code}: missing native label`);
    assert.deepEqual(Object.keys(dictionaries[code]).sort(), englishKeys, `${code}: key mismatch`);
    for (const key of requiredMessages) assert.ok(dictionaries[code][key], `${code}: missing ${key}`);
    for (const [key, value] of Object.entries(dictionaries[code])) {
      assert.equal(typeof value, 'string', `${code}/${key}: must be translated`);
      assert.ok(value.trim(), `${code}/${key}: empty translation`);
      assert.notEqual(value, key, `${code}/${key}: untranslated key`);
      assert.ok(!value.includes('\uFFFD'), `${code}/${key}: damaged Unicode`);
    }
  }
});

test('every locale preserves the exact interpolation contract', () => {
  for (const [key, english] of Object.entries(dictionaries.en)) {
    for (const { code } of languages) {
      assert.deepEqual(placeholders(dictionaries[code][key]), placeholders(english), `${code}/${key}`);
    }
  }
});

test('all locales interpolate counts, interval limits and user handles without losing zero', () => {
  for (const { code } of languages) {
    const count = t(code, 'rowsCount', { count: 0 });
    assert.ok(count.includes('0'));
    assert.ok(!count.includes('{count}'));
    const uncertainCount = t(code, 'uncertainCount', { count: 0 });
    assert.ok(uncertainCount.includes('0'));
    assert.equal(placeholders(uncertainCount).length, 0);
    const preview = t(code, 'previewDetails', { interval: 17, limit: 23 });
    assert.ok(preview.includes('17') && preview.includes('23'));
    assert.equal(placeholders(preview).length, 0);
    const manual = t(code, 'manualConfirmDescription', { handle: 'Sample_Account' });
    assert.ok(manual.includes('@Sample_Account'));
    assert.equal(placeholders(manual).length, 0);
  }
});

test('interpolation handles literal replacement characters and leaves missing variables visible', () => {
  assert.equal(t('en', 'rowsCount', { count: '$&' }), '$& accounts');
  assert.equal(t('en', 'rowsCount'), '{count} accounts');
  assert.equal(t('en', 'rowsCount', {}), '{count} accounts');
  assert.equal(t('en', 'rowsCount', { count: '' }), ' accounts');
  assert.equal(t('en', 'rowsCount', Object.create({ count: 'prototype value' })), '{count} accounts');
});

test('unsupported locales use English while unknown diagnostic keys remain readable', () => {
  assert.equal(t('unsupported' as Language, 'connect'), dictionaries.en.connect);
  assert.equal(t('en', 'ADAPTER_DIAGNOSTIC'), 'ADAPTER_DIAGNOSTIC');
  assert.equal(t('en', 'toString'), 'toString');
  assert.equal(t('__proto__' as Language, 'connect'), dictionaries.en.connect);
});

test('author handle is identical in all locales and key safety messages are localized', () => {
  for (const { code } of languages) {
    assert.ok(t(code, 'followAuthor').includes('@MagicalStocker'));
    assert.ok(t(code, 'statusAuthorFollowed').includes('@MagicalStocker'));
    if (code !== 'en') {
      for (const key of ['autoDescription', 'unknownHelp', 'manualConfirmDescription', 'freeFooter', 'errorUncertain', 'errorAccountChanged']) {
        assert.notEqual(t(code, key), t('en', key), `${code}/${key}: English fallback`);
      }
    }
  }
});
