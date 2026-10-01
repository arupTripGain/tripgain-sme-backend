import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeEmailHtml } from '../src/utils/templateContext';

describe('Signature Normalization and Spacing Cleanup', () => {
  it('compacts consecutive signature lines separated into <p> tags into a single <p> with <br>', () => {
    const rawHtml = '<p>Would you be open to a call?</p><p></p><p>Best,</p><p>Arup Nirala</p><p>TripGain</p>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.strictEqual(
      normalized,
      '<p>Would you be open to a call?</p><p class="email-signature" style="margin-bottom:0;line-height:1.4;">Best,<br>Arup Nirala<br>TripGain</p>'
    );
  });

  it('removes ghost empty paragraphs that cause unintended double spacing', () => {
    const rawHtml = '<p>Hi Harshal,</p><p></p><p><br></p><p>&nbsp;</p><p>Next sentence.</p>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.strictEqual(normalized, '<p>Hi Harshal,</p><p>Next sentence.</p>');
  });

  it('handles variations of sign-offs like Regards, Warm regards, Thanks', () => {
    const rawHtml1 = '<p>Thanks & regards,</p><p>John Doe</p><p>Acme Corp</p>';
    assert.strictEqual(normalizeEmailHtml(rawHtml1), '<p class="email-signature" style="margin-bottom:0;line-height:1.4;">Thanks & regards,<br>John Doe<br>Acme Corp</p>');

    const rawHtml2 = '<p>Warm regards,</p><p>Jane Smith</p><p>VP Sales</p><p>TripGain</p>';
    assert.strictEqual(normalizeEmailHtml(rawHtml2), '<p class="email-signature" style="margin-bottom:0;line-height:1.4;">Warm regards,<br>Jane Smith<br>VP Sales<br>TripGain</p>');
  });

  it('preserves unsubscribe footers after the signature block', () => {
    const rawHtml = '<p>Question?</p><p>Best,</p><p>Arup Nirala</p><p>TripGain</p><p style="font-size: 11px;"><a href="#">Unsubscribe</a></p>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.strictEqual(
      normalized,
      '<p>Question?</p><p class="email-signature" style="margin-bottom:0;line-height:1.4;">Best,<br>Arup Nirala<br>TripGain</p><p style="font-size: 11px;"><a href="#">Unsubscribe</a></p>'
    );
  });

  it('compacts bullet paragraphs into a single compact <ul> without gaps', () => {
    const rawHtml = '<p>Teams can manage:</p><p>• Travel policies</p><p>• Employee expenses</p><p>Best,</p><p>Arup Nirala</p>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.ok(normalized.includes('<ul style="margin:8px 0 12px 0;padding-left:20px;list-style-type:disc;">'));
    assert.ok(normalized.includes('<li style="margin-bottom:3px;line-height:1.45;">Travel policies</li>'));
    assert.ok(normalized.includes('<li style="margin-bottom:3px;line-height:1.45;">Employee expenses</li>'));
    assert.ok(normalized.includes('<p class="email-signature" style="margin-bottom:0;line-height:1.4;">Best,<br>Arup Nirala</p>'));
  });

  it('compacts numbered paragraphs into a single compact <ol> without gaps', () => {
    const rawHtml = '<p>Steps:</p><p>1. First step</p><p>2. Second step</p><p>Thanks,</p><p>Arup</p>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.ok(normalized.includes('<ol style="margin:8px 0 12px 0;padding-left:20px;list-style-type:decimal;">'));
    assert.ok(normalized.includes('<li style="margin-bottom:3px;line-height:1.45;">First step</li>'));
    assert.ok(normalized.includes('<li style="margin-bottom:3px;line-height:1.45;">Second step</li>'));
    assert.ok(normalized.includes('<p class="email-signature" style="margin-bottom:0;line-height:1.4;">Thanks,<br>Arup</p>'));
  });

  it('unwraps nested <p> tags inside existing <li> tags for tight spacing', () => {
    const rawHtml = '<ul><li><p>Item 1</p></li><li><p>Item 2</p></li></ul>';
    const normalized = normalizeEmailHtml(rawHtml);
    assert.strictEqual(
      normalized,
      '<ul><li style="margin-bottom:3px;line-height:1.45;">Item 1</li><li style="margin-bottom:3px;line-height:1.45;">Item 2</li></ul>'
    );
  });
});
