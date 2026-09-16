import assert from 'assert';
import Handlebars from 'handlebars';

// Canonical registry mirror
const VARIABLE_REGISTRY: Record<string, any> = {
  firstName: { tag: '{{firstName}}', required: false, fallback: 'there' },
  lastName: { tag: '{{lastName}}', required: false },
  email: { tag: '{{email}}', required: false },
  title: { tag: '{{title}}', required: false, fallback: 'your role' },
  companyName: { tag: '{{companyName}}', required: true, fallback: 'your company' },
  website: { tag: '{{website}}', required: false },
  industry: { tag: '{{industry}}', required: false },
  companySize: { tag: '{{companySize}}', required: false },
  companyPhone: { tag: '{{companyPhone}}', required: false },
  personLinkedinUrl: { tag: '{{personLinkedinUrl}}', required: false },
  city: { tag: '{{city}}', required: false },
  personalization: { tag: '{{personalization}}', required: false },
  personalizedLine: { tag: '{{personalizedLine}}', required: false },
  senderName: { tag: '{{senderName}}', required: true, fallback: 'TripGain Team' },
  senderCompany: { tag: '{{senderCompany}}', required: true, fallback: 'TripGain' },
  unsubscribeLink: { tag: '{{unsubscribeLink}}', required: false, fallback: '#' },
};

function autoBalanceTags(templateStr: string): string {
  if (!templateStr) return '';
  let result = templateStr;
  const blocks = ['if', 'unless', 'each', 'with'];
  for (const block of blocks) {
    const openMatches = result.match(new RegExp(`\\{\\{#${block}\\b[^}]*\\}\\}`, 'g')) || [];
    const closeMatches = result.match(new RegExp(`\\{\\{/${block}\\}\\}`, 'g')) || [];
    const diff = openMatches.length - closeMatches.length;
    if (diff > 0) {
      result = result.trimEnd() + '\n' + `{{/${block}}}\n`.repeat(diff).trimEnd();
    }
  }
  return result;
}

function htmlToHandlebars(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&#xA0;/gi, ' ')
    .replace(/\u00A0/g, ' ');

  text = text.replace(/\{\{([^{}]+)\}\}/g, (_match, inner) => {
    const cleanedInner = inner.replace(/<[^>]+>/g, '').trim();
    return `{{${cleanedInner}}}`;
  });

  text = text
    .replace(/&#125;/g, '}')
    .replace(/&#x7D;/gi, '}')
    .replace(/&#123;/g, '{')
    .replace(/&#x7B;/gi, '{');

  return text.trim();
}

function renderTemplate(
  templateStr: string,
  data: Record<string, any>,
  mode: 'Strict' | 'Standard' | 'Flexible' = 'Standard',
  highlightVariables = false
): string {
  if (!templateStr) return '';

  const plainTemplate = autoBalanceTags(htmlToHandlebars(templateStr));

  try {
    const instance = Handlebars.create();

    instance.registerHelper('helperMissing', function (...args: any[]) {
      const options = args[args.length - 1];
      const key = options?.name || '';
      const config = VARIABLE_REGISTRY[key];

      if (highlightVariables) {
        return new instance.SafeString(
          `<span class="bg-red-100 text-red-800 px-1 rounded mx-0.5 font-bold" title="Missing variable ${key}">[MISSING ${key}]</span>`
        );
      }

      if (config?.fallback) {
        return config.fallback;
      }
      return '';
    });

    const processedData: Record<string, any> = {};

    for (const key of Object.keys(VARIABLE_REGISTRY)) {
      let rawVal = data[key];

      if ((rawVal === undefined || rawVal === null || rawVal.toString().trim() === '') && key === 'personalization') {
        rawVal = data.personalizedLine;
      } else if ((rawVal === undefined || rawVal === null || rawVal.toString().trim() === '') && key === 'personalizedLine') {
        rawVal = data.personalization;
      }

      const isMissing = rawVal === undefined || rawVal === null || rawVal.toString().trim() === '';

      if (!isMissing) {
        if (highlightVariables) {
          processedData[key] = new instance.SafeString(
            `<span class="bg-blue-100 text-blue-800 px-1 rounded mx-0.5 whitespace-pre-wrap" title="${key}">${rawVal}</span>`
          );
        } else {
          processedData[key] = rawVal;
        }
      }
    }

    for (const key of Object.keys(data)) {
      if (!processedData.hasOwnProperty(key)) {
        const rawVal = data[key];
        const isMissing = rawVal === undefined || rawVal === null || rawVal.toString().trim() === '';
        if (!isMissing) {
          if (highlightVariables) {
            processedData[key] = new instance.SafeString(
              `<span class="bg-blue-100 text-blue-800 px-1 rounded mx-0.5 whitespace-pre-wrap" title="${key}">${rawVal}</span>`
            );
          } else {
            processedData[key] = rawVal;
          }
        }
      }
    }

    const template = instance.compile(plainTemplate, { noEscape: true });
    let output = template(processedData);

    output = output.replace(/<p>\s*(?:<br\s*\/?>|&nbsp;|\s)*<\/p>/gi, '');
    output = output.replace(/ {2,}/g, ' ');
    output = output.replace(/ ,/g, ',');
    output = output.replace(/ \./g, '.');
    output = output.replace(/\n{3,}/g, '\n\n');

    if (!highlightVariables) {
      output = output.replace(/\{\{[^}]+\}\}/g, '');
    }

    return output.trim();
  } catch (e: any) {
    return highlightVariables
      ? `<span class="text-red-600 font-bold">Template Syntax Error: ${e.message}</span>`
      : plainTemplate;
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('   TEMPLATE ENGINE CONDITIONAL RENDERING TEST SUITE             ');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function runTest(name: string, fn: () => void) {
    total++;
    try {
      fn();
      console.log(`  [PASS] Test ${total}: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  [FAIL] Test ${total}: ${name}`);
      console.error(`         ${err.message}`);
      throw err;
    }
  }

  // 1. IF with existing variable
  runTest('1. IF with existing variable renders inner content', () => {
    const tmpl = '{{#if firstName}}Hello {{firstName}}!{{/if}}';
    const out = renderTemplate(tmpl, { firstName: 'Arup' }, 'Standard', false);
    assert.strictEqual(out, 'Hello Arup!');
  });

  // 2. IF with missing variable
  runTest('2. IF with missing variable renders nothing', () => {
    const tmpl = '{{#if firstName}}Hello {{firstName}}!{{/if}}';
    const out = renderTemplate(tmpl, { firstName: '' }, 'Standard', false);
    assert.strictEqual(out, '');
  });

  // 3. IF/ELSE with existing variable
  runTest('3. IF/ELSE with existing variable renders TRUE branch', () => {
    const tmpl = '{{#if companyName}}{{companyName}}{{else}}your team{{/if}}';
    const out = renderTemplate(tmpl, { companyName: 'TripGain' }, 'Standard', false);
    assert.strictEqual(out, 'TripGain');
  });

  // 4. IF/ELSE with missing variable
  runTest('4. IF/ELSE with missing variable renders FALSE branch without [MISSING ...]', () => {
    const tmpl = 'You’re already registered with TripGain, so {{#if companyName}}{{companyName}}{{else}}your team{{/if}} is ready to book its next business trip.';
    const outClean = renderTemplate(tmpl, { companyName: '' }, 'Standard', false);
    assert.strictEqual(outClean, 'You’re already registered with TripGain, so your team is ready to book its next business trip.');

    const outPreview = renderTemplate(tmpl, { companyName: '' }, 'Standard', true);
    assert.strictEqual(outPreview, 'You’re already registered with TripGain, so your team is ready to book its next business trip.');
    assert.ok(!outPreview.includes('[MISSING'), 'Should not contain [MISSING in preview');
  });

  // 5. Nested IF/ELSE (all 4 combinations)
  runTest('5. Nested IF/ELSE handles all 4 truth combinations accurately', () => {
    const tmpl = '{{#if firstName}}{{firstName}}, one operational task to simplify as {{#if companyName}}{{companyName}}{{else}}your team{{/if}} grows{{else}}One operational task to simplify as {{#if companyName}}{{companyName}}{{else}}your team{{/if}} grows{{/if}}';

    // TC1: Arup + TripGain
    const tc1 = renderTemplate(tmpl, { firstName: 'Arup', companyName: 'TripGain' }, 'Standard', false);
    assert.strictEqual(tc1, 'Arup, one operational task to simplify as TripGain grows');

    // TC2: Arup + empty
    const tc2 = renderTemplate(tmpl, { firstName: 'Arup', companyName: '' }, 'Standard', false);
    assert.strictEqual(tc2, 'Arup, one operational task to simplify as your team grows');

    // TC3: empty + TripGain
    const tc3 = renderTemplate(tmpl, { firstName: '', companyName: 'TripGain' }, 'Standard', false);
    assert.strictEqual(tc3, 'One operational task to simplify as TripGain grows');

    // TC4: empty + empty
    const tc4 = renderTemplate(tmpl, { firstName: '', companyName: '' }, 'Standard', false);
    assert.strictEqual(tc4, 'One operational task to simplify as your team grows');
  });

  // 6. Empty personalization conditional
  runTest('6. Empty personalization conditional leaves no empty paragraph and no missing error', () => {
    const tmpl = '<p>Hi {{firstName}},</p><p>{{#if personalization}}{{personalization}}{{/if}}</p><p>As your company grows...</p>';
    const out = renderTemplate(tmpl, { firstName: 'Arup', personalization: '' }, 'Standard', true);
    assert.ok(!out.includes('[MISSING'), 'Should not contain [MISSING personalization]');
    assert.ok(!out.includes('<p></p>'), 'Should not contain empty paragraph');
    assert.ok(!out.includes('<p><br></p>'), 'Should not contain empty br paragraph');
    assert.ok(out.includes('Hi <span class="bg-blue-100'), 'Should contain highlighted firstName');
    assert.ok(out.includes('As your company grows...'));
  });

  // 7. Multiple conditionals in one template
  runTest('7. Multiple conditionals in one template evaluate independently', () => {
    const tmpl = 'Hi {{#if firstName}}{{firstName}}{{else}}there{{/if}}, welcome to {{#if companyName}}{{companyName}}{{else}}our community{{/if}}!';
    
    const out1 = renderTemplate(tmpl, { firstName: 'Arup', companyName: '' }, 'Standard', false);
    assert.strictEqual(out1, 'Hi Arup, welcome to our community!');

    const out2 = renderTemplate(tmpl, { firstName: '', companyName: 'TripGain' }, 'Standard', false);
    assert.strictEqual(out2, 'Hi there, welcome to TripGain!');
  });

  // 8. Missing firstName with and without fallback
  runTest('8. Missing firstName: renders fallback in IF/ELSE, flags [MISSING firstName] when bare in preview', () => {
    const tmplWithFallback = 'Hi {{#if firstName}}{{firstName}}{{else}}there{{/if}},';
    const outFallback = renderTemplate(tmplWithFallback, { firstName: '' }, 'Standard', true);
    assert.strictEqual(outFallback, 'Hi there,');

    const tmplBare = 'Hello {{firstName}},';
    const outBare = renderTemplate(tmplBare, { firstName: '' }, 'Standard', true);
    assert.ok(outBare.includes('[MISSING firstName]'), 'Bare missing variable should be flagged in preview');
  });

  // 9. Missing companyName with and without fallback
  runTest('9. Missing companyName: renders fallback in IF/ELSE, flags [MISSING companyName] when bare in preview', () => {
    const tmplWithFallback = '{{#if companyName}}{{companyName}}{{else}}your company{{/if}}';
    const outFallback = renderTemplate(tmplWithFallback, { companyName: '' }, 'Standard', true);
    assert.strictEqual(outFallback, 'your company');

    const tmplBare = 'Welcome to {{companyName}}!';
    const outBare = renderTemplate(tmplBare, { companyName: '' }, 'Standard', true);
    assert.ok(outBare.includes('[MISSING companyName]'), 'Bare missing companyName should be flagged in preview');
  });

  // 10. Both firstName and companyName missing
  runTest('10. Both firstName and companyName missing simultaneously', () => {
    const tmpl = 'Hi {{#if firstName}}{{firstName}}{{else}}there{{/if}}, how is {{#if companyName}}{{companyName}}{{else}}your team{{/if}}?';
    const out = renderTemplate(tmpl, { firstName: '', companyName: '' }, 'Standard', false);
    assert.strictEqual(out, 'Hi there, how is your team?');
  });

  // 11. No raw {{...}} syntax in final rendered output
  runTest('11. No raw {{...}} syntax remains in rendered output', () => {
    const tmpl = 'Hello {{#if firstName}}{{firstName}}{{else}}there{{/if}} from {{#if companyName}}{{companyName}}{{else}}us{{/if}} {{unknownVar}}';
    const out = renderTemplate(tmpl, { firstName: '', companyName: '' }, 'Standard', false);
    assert.ok(!/\{\{[^}]+\}\}/.test(out), `Should not contain raw {{...}}: "${out}"`);
    assert.strictEqual(out, 'Hello there from us');
  });

  // 12. No [MISSING variable] for variables inside unselected IF branches
  runTest('12. Variables inside unselected branches are never flagged as missing', () => {
    const tmpl = 'Hello {{#if companyName}}{{companyName}} ({{industry}}){{else}}there{{/if}}!';
    // Both companyName and industry are missing, but because companyName is falsy, the whole true branch is unselected
    const out = renderTemplate(tmpl, { companyName: '', industry: '' }, 'Standard', true);
    assert.strictEqual(out, 'Hello there!');
    assert.ok(!out.includes('[MISSING'), 'Should not contain [MISSING anywhere');
  });

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed}/${total} PASSED (100%)              `);
  console.log('================================================================\n');
}

runAllTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
