export interface StepProgressItem {
  stepId: string;
  stepNumber: number;
  stepName: string;
  eligibleCount: number;
  sentCount: number;
  remainingCount: number;
  completionPercentage: number;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
}

export interface CampaignCompletionInfo {
  completed: boolean;
  totalSteps: number;
  completedSteps: number;
  totalEligibleContacts: number;
  completedContacts: number;
}

export interface CampaignProgressResult {
  stepProgress: StepProgressItem[];
  campaignCompletion: CampaignCompletionInfo;
}

/**
 * Valid message statuses that count as sent / dispatched.
 * Failed, draft, pending, and queued messages are excluded.
 */
const VALID_SENT_STATUSES = new Set(['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced']);

export function isMessageSent(m: { status?: string | null; sentAt?: Date | string | null }): boolean {
  if (!m || !m.status) return false;
  const s = m.status.toLowerCase();
  if (VALID_SENT_STATUSES.has(s)) return true;
  if (m.sentAt !== null && m.sentAt !== undefined && !['failed', 'draft', 'pending', 'queued'].includes(s)) {
    return true;
  }
  return false;
}

/**
 * Terminal stopped statuses for enrollments that did not proceed to later steps.
 */
const TERMINAL_STOPPED_STATUSES = new Set(['replied', 'bounced', 'soft_bounced', 'unsubscribed', 'stopped']);

/**
 * Sensible percentage formatting:
 * - 0% -> 0
 * - < 1% -> rounded to 1 or 2 decimals (e.g. 0.2, 0.05) without redundant trailing zeros
 * - >= 1% -> whole number if integer (e.g. 50, 35) or 1 decimal place (e.g. 7.8)
 * - clamped between 0 and 100
 */
export function formatCompletionPercentage(sentCount: number, eligibleCount: number): number {
  if (!eligibleCount || eligibleCount <= 0 || !sentCount || sentCount <= 0) {
    return 0;
  }
  const rawPct = (sentCount / eligibleCount) * 100;
  const clamped = Math.min(100, Math.max(0, rawPct));

  if (clamped >= 100) return 100;
  if (clamped <= 0) return 0;

  if (clamped < 1) {
    const twoDecimals = Number(clamped.toFixed(2));
    if (twoDecimals > 0) return twoDecimals;
    return Number(clamped.toPrecision(1));
  }

  const oneDecimal = Number(clamped.toFixed(1));
  if (oneDecimal % 1 === 0) {
    return Math.round(oneDecimal);
  }
  return oneDecimal;
}

/**
 * Calculates step progress and overall campaign completion for a given campaign.
 * Handles single/multiple steps, partially completed steps, paused/completed campaigns,
 * unsubscribed/replied/bounced contacts, and duplicate sends per contact/step.
 */
export function calculateCampaignStepProgressAndCompletion(campaign: {
  sequences?: Array<{
    steps?: Array<{
      id: string;
      stepNumber: number;
      stepName?: string | null;
      subjectTemplate?: string | null;
      stepType?: string | null;
    }>;
  }>;
  enrollments?: Array<{
    id: string;
    status: string;
    currentStep?: number | null;
  }>;
  messages?: Array<{
    id: string;
    status: string;
    sentAt?: Date | string | null;
    createdAt?: Date | string | null;
    sequenceStepId?: string | null;
    enrollmentId?: string | null;
    toEmail?: string | null;
  }>;
}): CampaignProgressResult {
  // 1. Gather and sort all sequence steps across sequences by stepNumber
  const rawSteps = campaign.sequences?.flatMap(seq => seq.steps || []) || [];
  const steps = [...rawSteps].sort((a, b) => a.stepNumber - b.stepNumber);

  const enrollments = campaign.enrollments || [];
  const messages = campaign.messages || [];

  // If no steps exist
  if (steps.length === 0) {
    return {
      stepProgress: [],
      campaignCompletion: {
        completed: false,
        totalSteps: 0,
        completedSteps: 0,
        totalEligibleContacts: enrollments.length,
        completedContacts: 0
      }
    };
  }

  // 2. Index valid sent messages by stepNumber and recipient key
  // Ensures no duplicate counting of recipient per step
  const stepById = new Map<string, typeof steps[0]>();
  const stepByNumber = new Map<number, typeof steps[0]>();
  const stepSentRecipientsMap = new Map<number, Set<string>>();

  for (const s of steps) {
    stepById.set(s.id, s);
    stepByNumber.set(s.stepNumber, s);
    stepSentRecipientsMap.set(s.stepNumber, new Set());
  }

  // Group valid sent messages by recipient/enrollment key
  const recipientMessagesMap = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!isMessageSent(m)) continue;
    const recipientKey = m.enrollmentId || (m.toEmail ? m.toEmail.trim().toLowerCase() : null);
    if (!recipientKey) continue;
    if (!recipientMessagesMap.has(recipientKey)) {
      recipientMessagesMap.set(recipientKey, []);
    }
    recipientMessagesMap.get(recipientKey)!.push(m);
  }

  // For each recipient, map messages to steps chronologically
  for (const [recipientKey, msgs] of recipientMessagesMap.entries()) {
    // Sort messages chronologically
    msgs.sort((a, b) => {
      const timeA = a.sentAt ? new Date(a.sentAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const timeB = b.sentAt ? new Date(b.sentAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return timeA - timeB;
    });

    const assignedStepNumbers = new Set<number>();

    // Pass 1: Messages with explicit sequenceStepId matching a known step
    for (const m of msgs) {
      if (m.sequenceStepId && stepById.has(m.sequenceStepId)) {
        const stepNum = stepById.get(m.sequenceStepId)!.stepNumber;
        stepSentRecipientsMap.get(stepNum)?.add(recipientKey);
        assignedStepNumbers.add(stepNum);
        // Preceding steps were inherently sent
        for (let prev = 1; prev < stepNum; prev++) {
          stepSentRecipientsMap.get(prev)?.add(recipientKey);
          assignedStepNumbers.add(prev);
        }
      }
    }

    // Pass 2: Messages with unmapped or null sequenceStepId (legacy dispatches)
    // Assign each to the earliest unassigned stepNumber chronologically
    let nextUnassignedStep = 1;
    for (const m of msgs) {
      if (!m.sequenceStepId || !stepById.has(m.sequenceStepId)) {
        while (assignedStepNumbers.has(nextUnassignedStep) && nextUnassignedStep <= steps.length) {
          nextUnassignedStep++;
        }
        const stepNum = Math.min(nextUnassignedStep, steps.length);
        stepSentRecipientsMap.get(stepNum)?.add(recipientKey);
        assignedStepNumbers.add(stepNum);
        for (let prev = 1; prev < stepNum; prev++) {
          stepSentRecipientsMap.get(prev)?.add(recipientKey);
          assignedStepNumbers.add(prev);
        }
        nextUnassignedStep++;
      }
    }
  }

  // Pass 3: Account for enrollment currentStep and completion progression
  for (const e of enrollments) {
    const eKey = e.id;
    const curStep = e.currentStep || 1;
    // An enrollment that reached currentStep > 1 has completed all prior steps
    for (let prev = 1; prev < curStep && prev <= steps.length; prev++) {
      stepSentRecipientsMap.get(prev)?.add(eKey);
    }
    // If enrollment is marked completed, all steps were sent
    if (e.status === 'completed') {
      for (let s = 1; s <= steps.length; s++) {
        stepSentRecipientsMap.get(s)?.add(eKey);
      }
    }
  }

  // 3. Calculate metrics for each step
  const stepProgress: StepProgressItem[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepNumber = step.stepNumber;
    const sentSet = stepSentRecipientsMap.get(stepNumber) || new Set();
    const sentCount = sentSet.size;

    // Step Name: from existing sequence step data, or sensible fallback if empty
    const stepName = step.stepName?.trim() || (
      stepNumber === 1 ? 'Initial Outreach' :
      stepNumber === 2 ? 'Follow-up' :
      stepNumber === 3 ? 'Final Follow-up' :
      `Step ${stepNumber}`
    );

    // Denominator is the total campaign contact count excluding unsubscribed or paused contacts
    const activeEnrollments = enrollments.filter(e => {
      const s = (e.status || '').toLowerCase();
      return s !== 'unsubscribed' && s !== 'paused';
    });
    const totalApplicableContacts = activeEnrollments.length;
    const eligibleCount = Math.max(totalApplicableContacts, sentCount);

    const remainingCount = Math.max(0, eligibleCount - sentCount);
    const completionPercentage = formatCompletionPercentage(sentCount, eligibleCount);

    let status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' = 'NOT_STARTED';
    if (sentCount === 0 || eligibleCount === 0) {
      status = 'NOT_STARTED';
    } else if (sentCount >= eligibleCount) {
      status = 'COMPLETED';
    } else {
      status = 'IN_PROGRESS';
    }

    stepProgress.push({
      stepId: step.id,
      stepNumber,
      stepName,
      eligibleCount,
      sentCount,
      remainingCount,
      completionPercentage,
      status
    });
  }

  // 4. Calculate overall campaign completion
  const totalSteps = steps.length;
  const completedSteps = stepProgress.filter(s => s.status === 'COMPLETED').length;
  const totalEligibleContacts = enrollments.filter(e => {
    const s = (e.status || '').toLowerCase();
    return s !== 'unsubscribed' && s !== 'paused';
  }).length;

  const lastStep = steps[steps.length - 1];
  const lastStepNumber = lastStep?.stepNumber ?? 0;
  const lastStepSentSet = lastStep ? (stepSentRecipientsMap.get(lastStepNumber) || new Set()) : new Set<string>();

  const completedEnrollments = enrollments.filter(e => {
    if ((e.status || '').toLowerCase() === 'completed') return true;
    if (lastStepSentSet.has(e.id)) {
      return true;
    }
    return false;
  });

  const completedContacts = completedEnrollments.length;

  // Genuine campaign completion:
  // Requires at least 1 step and at least 1 enrolled contact.
  // Complete when all steps have status COMPLETED, or all enrolled contacts completed all steps.
  const allStepsCompleted = totalSteps > 0 && completedSteps === totalSteps && totalEligibleContacts > 0;
  const allContactsCompleted = totalSteps > 0 && totalEligibleContacts > 0 && completedContacts >= totalEligibleContacts;

  const isCompleted = allStepsCompleted || allContactsCompleted;

  return {
    stepProgress,
    campaignCompletion: {
      completed: isCompleted,
      totalSteps,
      completedSteps,
      totalEligibleContacts,
      completedContacts
    }
  };
}
