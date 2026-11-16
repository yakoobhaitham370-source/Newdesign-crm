import type { CrmState } from './crmRepository';
import type { Language, PatientAllergy } from '../types/domain';

export interface AllergyDraftInput {
  substance: string;
  severity: PatientAllergy['severity'];
  reaction: string;
}

export interface RpcAllergyPayloadItem {
  substance: string;
  severity: 'mild' | 'moderate' | 'severe';
  reaction: string | null;
}

let allergyIdCounter = 0;

export function createLocalAllergyId(): string {
  allergyIdCounter += 1;
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return `alg-${globalThis.crypto.randomUUID()}`;
  }
  return `alg-${Date.now()}-${allergyIdCounter}`;
}

export function normalizeAllergyKey(substance: string): string {
  return substance.trim().toLowerCase();
}

export function normalizeAllergyReaction(reaction?: string | null): string | undefined {
  const trimmed = (reaction ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function findDuplicateAllergy(
  allergies: PatientAllergy[],
  candidateSubstance: string
): PatientAllergy | undefined {
  const key = normalizeAllergyKey(candidateSubstance);
  if (!key) return undefined;
  return allergies.find((a) => normalizeAllergyKey(a.substance) === key);
}

export function validateAndAddAllergyToList(
  existingAllergies: PatientAllergy[],
  draft: AllergyDraftInput,
  lang: Language
):
  | { ok: true; allergies: PatientAllergy[]; added: PatientAllergy }
  | { ok: false; error: string } {
  const isAr = lang === 'ar';
  const substance = draft.substance.trim();
  const reaction = normalizeAllergyReaction(draft.reaction);

  if (!substance) {
    if (reaction) {
      return {
        ok: false,
        error: isAr
          ? 'يرجى إدخال اسم المادة المسببة للحساسية (حرفين على الأقل) مع التفاعل.'
          : 'Please enter the allergy substance (at least 2 characters) along with the reaction.',
      };
    }
    return {
      ok: false,
      error: isAr
        ? 'يرجى إدخال اسم المادة المسببة للحساسية (حرفين على الأقل).'
        : 'Please enter an allergy substance (at least 2 characters).',
    };
  }

  if (substance.length < 2) {
    return {
      ok: false,
      error: isAr
        ? 'اسم المادة المسببة للحساسية يجب أن يكون حرفين على الأقل.'
        : 'Allergy substance must be at least 2 characters.',
    };
  }

  const duplicate = findDuplicateAllergy(existingAllergies, substance);
  if (duplicate) {
    return {
      ok: false,
      error: isAr
        ? `المادة "${substance}" مضافة مسبقاً في قائمة الحساسية.`
        : `Allergy substance "${substance}" is already in the list.`,
    };
  }

  const added: PatientAllergy = {
    id: createLocalAllergyId(),
    substance,
    severity: draft.severity,
    reaction,
  };

  return {
    ok: true,
    allergies: [...existingAllergies, added],
    added,
  };
}

/**
 * Resolves the authoritative allergies array to submit when saving a patient form.
 * Never silently discards a typed allergy draft:
 * - If draft is completely empty (substance & reaction blank), submits existing allergies.
 * - If draft is incomplete/invalid (reaction without substance, <2 char substance, or duplicate), returns a bilingual validation error.
 * - If draft is valid and unique, automatically includes it in the submitted allergies array.
 */
export function resolveAllergiesForSubmit(
  existingAllergies: PatientAllergy[],
  draft: AllergyDraftInput,
  lang: Language
):
  | { ok: true; allergies: PatientAllergy[]; mergedDraft: boolean }
  | { ok: false; error: string } {
  const isAr = lang === 'ar';
  const seen = new Set<string>();
  const normalizedExisting: PatientAllergy[] = [];

  for (const item of existingAllergies) {
    const substance = item.substance.trim();
    const key = normalizeAllergyKey(substance);
    if (substance.length < 2) {
      return {
        ok: false,
        error: isAr
          ? 'اسم المادة المسببة للحساسية يجب أن يكون حرفين على الأقل.'
          : 'Allergy substance must be at least 2 characters.',
      };
    }
    if (seen.has(key)) {
      return {
        ok: false,
        error: isAr
          ? `توجد مادة حساسية مكررة: "${substance}".`
          : `Duplicate allergy substance detected: "${substance}".`,
      };
    }
    seen.add(key);
    normalizedExisting.push({
      id: item.id,
      substance,
      severity: item.severity,
      reaction: normalizeAllergyReaction(item.reaction),
    });
  }

  const draftSubstance = draft.substance.trim();
  const draftReaction = normalizeAllergyReaction(draft.reaction);

  if (!draftSubstance && !draftReaction) {
    return { ok: true, allergies: normalizedExisting, mergedDraft: false };
  }

  if (!draftSubstance && draftReaction) {
    return {
      ok: false,
      error: isAr
        ? 'تم إدخال وصف التفاعل للحساسية بدون اسم المادة. يرجى إدخال اسم المادة (حرفين على الأقل) أو مسح حقل التفاعل قبل الحفظ.'
        : 'An allergy reaction was entered without a substance name. Enter the substance (at least 2 characters) or clear the reaction before saving.',
    };
  }

  const merged = validateAndAddAllergyToList(normalizedExisting, draft, lang);
  if (!merged.ok) {
    return merged;
  }

  return {
    ok: true,
    allergies: merged.allergies,
    mergedDraft: true,
  };
}

export function buildAllergiesRpcPayload(allergies: PatientAllergy[]): RpcAllergyPayloadItem[] {
  return allergies.map((a) => ({
    substance: a.substance.trim(),
    severity: a.severity,
    reaction: normalizeAllergyReaction(a.reaction) ?? null,
  }));
}

export function verifyPersistedAllergies(
  expectedAllergies: PatientAllergy[],
  actualAllergies: PatientAllergy[]
): { ok: true } | { ok: false; reason: 'missing' | 'mismatch' | 'unexpected_count' } {
  const expectedNormalized = buildAllergiesRpcPayload(expectedAllergies);
  const actualByKey = new Map<string, RpcAllergyPayloadItem>();

  for (const actual of actualAllergies) {
    actualByKey.set(normalizeAllergyKey(actual.substance), {
      substance: actual.substance.trim(),
      severity: actual.severity,
      reaction: normalizeAllergyReaction(actual.reaction) ?? null,
    });
  }

  for (const exp of expectedNormalized) {
    const found = actualByKey.get(normalizeAllergyKey(exp.substance));
    if (!found) {
      return { ok: false, reason: 'missing' };
    }
    if (
      found.substance !== exp.substance ||
      found.severity !== exp.severity ||
      found.reaction !== exp.reaction
    ) {
      return { ok: false, reason: 'mismatch' };
    }
  }

  if (actualByKey.size !== expectedNormalized.length) {
    return { ok: false, reason: 'unexpected_count' };
  }

  return { ok: true };
}

export class AllergyPersistenceVerificationError extends Error {
  public readonly reloadedState?: CrmState;
  public readonly reason: 'missing' | 'mismatch' | 'unexpected_count';

  constructor(
    reason: 'missing' | 'mismatch' | 'unexpected_count',
    reloadedState?: CrmState
  ) {
    super(
      'Patient record saved, but submitted allergy persistence could not be verified in the authoritative pharmacy database. Please inspect the patient record before retrying.'
    );
    this.name = 'AllergyPersistenceVerificationError';
    this.reason = reason;
    this.reloadedState = reloadedState;
  }
}

export function isAllergyPersistenceVerificationError(
  err: unknown
): err is AllergyPersistenceVerificationError {
  return err instanceof AllergyPersistenceVerificationError;
}

export function getBilingualAllergyVerificationMessage(lang: Language): string {
  return lang === 'ar'
    ? 'تم تنفيذ الحفظ ولكن تعذر التحقق من تثبيت بيانات الحساسية في قاعدة البيانات. لم يتم إغلاق النموذج؛ يرجى مراجعة ملف المراجع قبل إعادة المحاولة.'
    : 'Save completed, but allergy persistence could not be confirmed in the authoritative database. Your form has been kept open—please verify the patient record before retrying.';
}
