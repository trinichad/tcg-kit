import { describe, expect, it } from 'vitest';
import {
  nameSim,
  normNum,
  normNumber,
  normText,
  numMatch,
  numberScore,
  numberTokens,
  numberTotal,
  numberingOk,
  splitProductName,
} from '../../src/pricing/index';

describe('normNumber (lenient — BinderPricer)', () => {
  it('strips leading zeros in every digit run and lower-cases', () => {
    expect(normNumber('004/102')).toBe('4/102');
    expect(normNumber('LOB-EN001')).toBe('lob-en1');
    expect(normNumber('TG18/TG30')).toBe('tg18/tg30');
    expect(normNumber(' 44 / 102 ')).toBe('44/102');
  });
});

describe('normNum (strict — PokéDebut, merged onto normNumber)', () => {
  it('normalises a plain card number', () => {
    expect(normNum('044/102')).toBe('44/102');
    expect(normNum('44')).toBe('44');
    expect(normNum('TG18/TG30')).toBe('tg18/tg30');
  });

  it('rejects anything that is not a bare card number', () => {
    expect(normNum('')).toBe('');
    expect(normNum('Unknown')).toBe('');
    expect(normNum('LOB-EN001')).toBe(''); // hyphenated set codes are not bare numbers
    expect(normNum('not a number')).toBe('');
  });

  it('keeps a lone zero', () => {
    expect(normNum('0')).toBe('0');
    expect(normNum('00')).toBe('0');
  });
});

describe('numberTokens', () => {
  it('splits a multi-card number field, normalised and de-duplicated', () => {
    expect(numberTokens('53/111, 54/111')).toEqual(['53/111', '54/111']);
    expect(numberTokens('18/106 19/106')).toEqual(['18/106', '19/106']);
    expect(numberTokens('AR1, AR2')).toEqual(['ar1', 'ar2']);
    expect(numberTokens('044/102, 44/102')).toEqual(['44/102']);
  });

  it('drops junk and empties', () => {
    expect(numberTokens('')).toEqual([]);
    expect(numberTokens(null)).toEqual([]);
    expect(numberTokens('Unknown')).toEqual([]);
  });
});

describe('numMatch', () => {
  it('matches exact and bare-numerator forms', () => {
    expect(numMatch('044/102', '44/102')).toBe(true);
    expect(numMatch('44', '44/102')).toBe(true);
    expect(numMatch('44/102', '44')).toBe(true);
  });

  it('does not match across different set totals or junk', () => {
    expect(numMatch('44/102', '44/130')).toBe(false);
    expect(numMatch('', '44')).toBe(false);
    expect(numMatch('Unknown', '44')).toBe(false);
  });
});

describe('numberTotal / numberingOk', () => {
  it('reads the set total', () => {
    expect(numberTotal('4/102')).toBe('102');
    expect(numberTotal('4')).toBe('');
  });

  it('rejects two numbers whose totals disagree', () => {
    expect(numberingOk('5/102', '5/130')).toBe(false);
    expect(numberingOk('5/102', '5/102')).toBe(true);
    expect(numberingOk('5', '5/130')).toBe(true); // one side has no total
  });
});

describe('numberScore', () => {
  it('scores an exact match 1', () => {
    expect(numberScore('004/102', '4/102')).toBe(1);
  });

  it('forgives a Yu-Gi-Oh region infix', () => {
    expect(numberScore('LOB-001', 'LOB-EN001')).toBe(0.9);
  });

  it('is weak when the numerator matches but the totals disagree', () => {
    expect(numberScore('5/102', '5/130')).toBe(0.4);
    expect(numberScore('5/102', '5')).toBe(0.85);
  });

  it('is zero for unrelated numbers', () => {
    expect(numberScore('4/102', '77/165')).toBe(0);
  });
});

describe('nameSim', () => {
  it('is 1 for an exact (normalised) match', () => {
    expect(nameSim('Charizard', 'charizard')).toBe(1);
  });

  it('credits containment', () => {
    expect(nameSim('Charizard', 'Charizard ex')).toBeGreaterThanOrEqual(0.66);
  });

  it('survives PriceCharting squashing punctuated names', () => {
    // "Monkey.D.Luffy" → "monkeydluffy" has no shared tokens with "monkey d luffy"
    expect(nameSim('Monkey.D.Luffy', 'monkey d luffy')).toBeGreaterThanOrEqual(0.85);
  });

  it('is 0 for empty input', () => {
    expect(nameSim('', 'Charizard')).toBe(0);
  });
});

describe('normText / splitProductName', () => {
  it('folds accents and punctuation to spaces', () => {
    expect(normText('Pokémon: Zoro-Juurou!')).toBe('pokemon zoro juurou');
  });

  it('splits "Name - number (suffix)" search names', () => {
    expect(splitProductName('Charizard - 4/102 (CoroCoro Promo)')).toEqual({
      name: 'Charizard (CoroCoro Promo)',
      number: '4/102',
    });
    expect(splitProductName('Sol Ring')).toEqual({ name: 'Sol Ring', number: '' });
  });
});
