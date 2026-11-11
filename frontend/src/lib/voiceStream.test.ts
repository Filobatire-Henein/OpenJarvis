import { describe, expect, it } from 'vitest';
import { splitSentences, visibleReplyText } from './voiceStream';

describe('splitSentences', () => {
  it('keeps the unfinished tail for later', () => {
    expect(splitSentences('One. Two', false)).toEqual({ pieces: ['One. '], consumed: 5 });
  });

  it('flushes the tail when final', () => {
    expect(splitSentences('One. Two', true).pieces).toEqual(['One. ', 'Two']);
  });

  it('does not split decimals or a period at the very end of a stream', () => {
    expect(splitSentences('Version 3.5 is out.', false).pieces).toEqual([]);
  });

  it('never cuts inside a code block', () => {
    const text = 'Run this:\n```\na = 1. b = 2.\n```\nDone. ';
    const { pieces } = splitSentences(text, false);
    expect(pieces.join('')).toBe(text);
    expect(pieces.some((p) => p.includes('a = 1.') && !p.includes('```'))).toBe(false);
  });
});

describe('visibleReplyText', () => {
  it('holds back an unclosed think block', () => {
    expect(visibleReplyText('<think>hmm')).toBe('');
  });
  it('drops a closed think block', () => {
    expect(visibleReplyText('<think>hmm</think>\nHi.')).toBe('Hi.');
  });
  it('drops reasoning when the opening tag is missing', () => {
    expect(visibleReplyText('reasoning</think>Hi.')).toBe('Hi.');
  });
});
