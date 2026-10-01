import test from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import { sendCampaignTestEmail } from '../src/controllers/campaignController';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/middleware/authMiddleware';

const prisma = new PrismaClient();

function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  body?: any;
  params?: Record<string, string>;
}) {
  const req: any = {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    user: options.user,
    body: options.body || {},
    params: options.params || {},
    query: {}
  };

  let statusCode = 200;
  let responseData: any = null;

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getResponseData: () => responseData
  };

  return { req, res };
}

test('Campaign Test Email - Controller Dispatch and Variable Resolution', async () => {
  // Find a connected mailbox or use admin
  const user = await prisma.user.findFirst({
    where: { role: 'ADMIN' }
  });
  assert.ok(user, 'Admin user must exist in DB');

  const mailbox = await prisma.mailbox.findFirst({
    where: { status: 'CONNECTED', isActive: true }
  });
  assert.ok(mailbox, 'At least one connected mailbox must exist in DB');

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET
  );

  // Mock nodemailer createTransport so we don't actually hit external SMTP servers during test
  const sentMails: any[] = [];
  const originalCreateTransport = nodemailer.createTransport;
  (nodemailer as any).createTransport = () => ({
    sendMail: async (mailOptions: any) => {
      sentMails.push(mailOptions);
      return { messageId: '<test-campaign-msg-id@domain.com>' };
    }
  });

  try {
    const { req, res } = createMockReqRes({
      token,
      user: { userId: user.id, email: user.email, role: user.role },
      body: {
        senderMailbox: mailbox.email,
        testRecipients: ['vikram@referrush.com'],
        subject: 'Hey {{firstName}} - regarding {{companyName}}',
        body: '<p>Hi {{firstName}},</p><p>We can help {{companyName}} in {{industry}}.</p><p>Best,</p><p>Arup Nirala</p><p>TripGain</p>',
        leadData: {
          firstName: 'Vikram',
          lastName: 'Pai',
          companyName: 'ReferRush',
          industry: 'Software',
          email: 'vikram@referrush.com'
        }
      }
    });

    await sendCampaignTestEmail(req, res);

    assert.strictEqual(res.getStatusCode(), 200, 'Endpoint should return HTTP 200');
    const data = res.getResponseData();
    assert.strictEqual(data.success, true, 'Dispatch should be marked successful');
    assert.strictEqual(data.totalSent, 1, 'Total sent should be 1');
    assert.strictEqual(sentMails.length, 1, 'One email should have been sent via transport');

    const sentMail = sentMails[0];
    assert.ok(sentMail.subject.includes('[TEST] Hey Vikram - regarding ReferRush'), 'Subject variables should be resolved');
    assert.ok(sentMail.html.includes('Hi Vikram,'), 'Body firstName should be resolved');
    assert.ok(sentMail.html.includes('ReferRush in Software'), 'Body company and industry should be resolved');
    assert.ok(sentMail.html.includes('email-signature'), 'Signature block should be compacted with email-signature class');
    assert.ok(!sentMail.html.includes('<p>Best,</p><p>Arup Nirala</p>'), 'Consecutive paragraphs in signature should be merged');
  } finally {
    (nodemailer as any).createTransport = originalCreateTransport;
  }
});

test('Campaign Test Email - Handles &nbsp; inside Handlebars tags and resilient fallback', async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  const mailbox = await prisma.mailbox.findFirst({ where: { status: 'CONNECTED', isActive: true } });
  const token = jwt.sign({ userId: user!.id, email: user!.email, role: user!.role }, JWT_SECRET);

  const sentMails: any[] = [];
  const originalCreateTransport = nodemailer.createTransport;
  (nodemailer as any).createTransport = () => ({
    sendMail: async (mailOptions: any) => {
      sentMails.push(mailOptions);
      return { messageId: '<test-nbsp-msg-id@domain.com>' };
    }
  });

  try {
    const { req, res } = createMockReqRes({
      token,
      user: { userId: user!.id, email: user!.email, role: user!.role },
      body: {
        senderMailbox: mailbox!.email,
        testRecipients: ['tester@tripgain.com'],
        subject: 'Hello&nbsp;{{#if&nbsp;firstName}}{{firstName}}{{/if}}',
        body: '<p>Hi&nbsp;{{#if&nbsp;firstName}}{{firstName}}{{else}}there{{/if}},</p><p>Testing nbsp sanitization.</p>',
        leadData: { firstName: 'Vikram', email: 'tester@tripgain.com' }
      }
    });

    await sendCampaignTestEmail(req, res);

    assert.strictEqual(res.getStatusCode(), 200, 'Should return HTTP 200 even with nbsp in Handlebars tags');
    const data = res.getResponseData();
    assert.strictEqual(data.success, true, 'Dispatch must succeed');
    assert.strictEqual(sentMails.length, 1);
    assert.ok(sentMails[0].html.includes('Hi Vikram,'), 'Must render firstName through nbsp helper block');
  } finally {
    (nodemailer as any).createTransport = originalCreateTransport;
  }
});

