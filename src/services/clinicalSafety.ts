import { MEDICATION_CATALOG } from '../data/seedData';
import {
  AdministrationRoute,
  AllergyOverrideAuthSource,
  AllergyOverrideAuthorization,
  DosageForm,
  Language,
  MedicationCatalogItem,
  MedicationPlanStatus,
  Patient,
  PatientAllergy,
  PatientMedicationPlan,
} from '../types/domain';
import type { NewMedicationPlanInput, RecordDispensingInput } from './crmRepository';
import {
  areUnitsCompatibleForRefill,
  diffDaysBetween,
  isValidIsoCalendarDate,
  normalizeClinicalUnitCategory,
  validateSchedule,
} from './scheduleEngine';

export { isValidIsoCalendarDate };

export const MAX_REASONABLE_DOSE_AMOUNT = 10000;
export const MAX_REASONABLE_DISPENSE_QTY = 100000;
export const EXPIRY_SOON_WARNING_DAYS = 30;

export const ALLOWED_ROUTES_BY_DOSAGE_FORM: Record<DosageForm, AdministrationRoute[]> = {
  tablet: ['oral'],
  capsule: ['oral'],
  syrup: ['oral'],
  sachet: ['oral'],
  inhaler: ['inhalation'],
  injection: ['subcutaneous', 'intramuscular', 'intravenous'],
  drops: ['ophthalmic', 'otic', 'oral'],
  cream: ['topical'],
};

export const ALLOWED_UNIT_CATEGORIES_BY_DOSAGE_FORM: Record<DosageForm, string[]> = {
  tablet: ['tablet'],
  capsule: ['capsule'],
  syrup: ['ml'],
  inhaler: ['puff'],
  injection: ['iu', 'injection_vial', 'ml'],
  drops: ['drop', 'ml'],
  cream: ['application', 'g', 'mg'],
  sachet: ['sachet'],
};

export function isMassStrengthUnitCategory(category: string): boolean {
  return category === 'mg' || category === 'mcg' || category === 'g';
}

export function validateDosageFormRouteCompatibility(
  dosageForm: DosageForm,
  route: AdministrationRoute,
  lang: Language
): { valid: boolean; error?: string } {
  const allowed = ALLOWED_ROUTES_BY_DOSAGE_FORM[dosageForm];
  if (allowed.includes(route)) {
    return { valid: true };
  }
  const isAr = lang === 'ar';
  return {
    valid: false,
    error: isAr
      ? `طريق الإعطاء (${route}) غير متوافق سريرياً مع الشكل الصيدلاني (${dosageForm}). الطرق المسموحة: ${allowed.join('، ')}.`
      : `Administration route (${route}) is clinically incompatible with dosage form (${dosageForm}). Allowed routes: ${allowed.join(', ')}.`,
  };
}

export function validateDosageFormUnitCompatibility(
  dosageForm: DosageForm,
  doseUnit: string,
  lang: Language
): { valid: boolean; error?: string } {
  const isAr = lang === 'ar';
  const trimmed = doseUnit.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: isAr ? 'وحدة الجرعة مطلوبة.' : 'Dose unit is required.',
    };
  }
  const category = normalizeClinicalUnitCategory(trimmed);
  const allowed = ALLOWED_UNIT_CATEGORIES_BY_DOSAGE_FORM[dosageForm];
  if (allowed.includes(category)) {
    return { valid: true };
  }
  if (
    isMassStrengthUnitCategory(category) &&
    (dosageForm === 'tablet' ||
      dosageForm === 'capsule' ||
      dosageForm === 'syrup' ||
      dosageForm === 'inhaler' ||
      dosageForm === 'sachet')
  ) {
    return {
      valid: false,
      error: isAr
        ? `وحدة "${trimmed}" تمثل وحدة تركيز/كتلة ولا تصلح كوحدة جرعة لهذا الشكل الصيدلاني (${dosageForm})؛ أدخل التركيز في حقل التركيز واستخدم وحدة الإعطاء الفعلية (مثل: ${allowed.join('، ')}).`
        : `Unit "${trimmed}" is a strength/mass unit and cannot be used as the administration dose unit for ${dosageForm}. Put strength in the Strength field and use a countable/volume unit (${allowed.join(', ')}).`,
    };
  }
  return {
    valid: false,
    error: isAr
      ? `وحدة الجرعة "${trimmed}" غير متوافقة مع الشكل الصيدلاني (${dosageForm}). الوحدات المتوافقة: ${allowed.join('، ')}.`
      : `Dose unit "${trimmed}" is incompatible with dosage form (${dosageForm}). Compatible unit categories: ${allowed.join(', ')}.`,
  };
}

export function validateMedicationPlanInput(
  input: NewMedicationPlanInput,
  lang: Language
): { valid: boolean; errors: string[] } {
  const isAr = lang === 'ar';
  const errors: string[] = [];

  if (!input.brandName.trim() && !input.genericName.trim()) {
    errors.push(
      isAr
        ? 'يرجى إدخال الاسم التجاري أو العلمي للدواء.'
        : 'Medication brand or generic name is required.'
    );
  }
  if (!input.strength.trim()) {
    errors.push(isAr ? 'يرجى تحديد التركيز الدوائي.' : 'Medication strength is required.');
  }
  if (!Number.isFinite(input.doseAmount) || input.doseAmount <= 0) {
    errors.push(
      isAr
        ? 'يجب إدخال مقدار الجرعة الموصوفة أكبر من صفر.'
        : 'Prescribed dose amount must be a finite number greater than zero.'
    );
  } else if (input.doseAmount > MAX_REASONABLE_DOSE_AMOUNT) {
    errors.push(
      isAr
        ? `مقدار الجرعة (${input.doseAmount}) يتجاوز الحد الأقصى الآمن المسموح (${MAX_REASONABLE_DOSE_AMOUNT}).`
        : `Dose amount (${input.doseAmount}) exceeds maximum safety threshold (${MAX_REASONABLE_DOSE_AMOUNT}).`
    );
  }

  if (!input.doseUnit.trim()) {
    errors.push(isAr ? 'وحدة الجرعة مطلوبة.' : 'Dose unit is required.');
  } else {
    const unitCompat = validateDosageFormUnitCompatibility(
      input.dosageForm,
      input.doseUnit,
      lang
    );
    if (!unitCompat.valid && unitCompat.error) {
      errors.push(unitCompat.error);
    }
  }

  const routeCompat = validateDosageFormRouteCompatibility(
    input.dosageForm,
    input.route,
    lang
  );
  if (!routeCompat.valid && routeCompat.error) {
    errors.push(routeCompat.error);
  }

  if (input.verifiedInstructions.trim().length < 5) {
    errors.push(
      isAr
        ? 'يرجى كتابة تعليمات الاستخدام الموثقة (٥ أحرف على الأقل).'
        : 'Verified administration instructions must be at least 5 characters.'
    );
  }

  if (!isValidIsoCalendarDate(input.startDate)) {
    errors.push(
      isAr
        ? 'تاريخ بداية العلاج غير صالح.'
        : 'Treatment start date is not a valid calendar date.'
    );
  }

  if (!input.isOngoing) {
    if (!isValidIsoCalendarDate(input.endDate)) {
      errors.push(
        isAr
          ? 'تاريخ انتهاء العلاج غير صالح للخطة محددة المدة.'
          : 'A valid treatment end date is required for finite courses.'
      );
    } else if (isValidIsoCalendarDate(input.startDate) && input.endDate! < input.startDate) {
      errors.push(
        isAr
          ? 'تاريخ الانتهاء لا يمكن أن يسبق تاريخ البداية.'
          : 'Treatment end date cannot precede start date.'
      );
    }
    if (
      input.durationDays !== undefined &&
      (!Number.isFinite(input.durationDays) ||
        !Number.isInteger(input.durationDays) ||
        input.durationDays < 1)
    ) {
      errors.push(
        isAr
          ? 'عدد أيام العلاج يجب أن يكون عدداً صحيحاً موجباً (١ يوم على الأقل).'
          : 'Duration days must be a positive integer (at least 1 day).'
      );
    }
  }

  const schedResult = validateSchedule(input.schedule, lang);
  if (!schedResult.valid) {
    errors.push(...schedResult.errors);
  }

  return { valid: errors.length === 0, errors };
}

export function validateMedicationEditAllowed(
  plan: PatientMedicationPlan,
  lang: Language,
  expectedVersionNumber?: number
): { allowed: boolean; error?: string } {
  const isAr = lang === 'ar';
  if (plan.status === 'discontinued' || plan.status === 'archived') {
    return {
      allowed: false,
      error: isAr
        ? `لا يمكن تعديل خطة دوائية بحالة (${plan.status === 'discontinued' ? 'موقوف نهائياً' : 'مؤرشف'}) حفاظاً على سلامة السجل التاريخي.`
        : `Cannot edit a ${plan.status} medication plan. Historical regimen records are immutable.`,
    };
  }
  if (
    expectedVersionNumber !== undefined &&
    expectedVersionNumber !== plan.currentVersionNumber
  ) {
    return {
      allowed: false,
      error: isAr
        ? `تم تحديث هذه الخطة الدوائية إلى النسخة v${plan.currentVersionNumber} أثناء مراجعتك. يرجى تحديث البيانات وإعادة التحقق قبل الحفظ.`
        : `This medication plan was updated to version v${plan.currentVersionNumber} in another session. Refresh state before saving.`,
    };
  }
  return { allowed: true };
}

export function validateMedicationStatusTransition(
  currentStatus: MedicationPlanStatus,
  nextStatus: MedicationPlanStatus,
  reason: string,
  lang: Language
): { allowed: boolean; error?: string } {
  const isAr = lang === 'ar';
  if (reason.trim().length < 2) {
    return {
      allowed: false,
      error: isAr
        ? 'يجب توثيق سبب تغيير حالة الخطة (حرفين على الأقل).'
        : 'Status change reason must be at least 2 characters.',
    };
  }
  if (currentStatus === 'archived') {
    return {
      allowed: false,
      error: isAr
        ? 'لا يمكن تغيير حالة خطة دوائية مؤرشفة.'
        : 'Cannot change status of an archived medication plan.',
    };
  }
  if (
    currentStatus === 'discontinued' &&
    (nextStatus === 'active' || nextStatus === 'paused')
  ) {
    return {
      allowed: false,
      error: isAr
        ? 'لا يمكن إعادة تفعيل خطة دوائية تم إيقافها نهائياً؛ أنشئ خطة جديدة موثقة بدلاً من ذلك.'
        : 'Cannot reactivate or pause a discontinued medication plan. Create a new verified plan instead.',
    };
  }
  return { allowed: true };
}

// ============================================================================
// ALLERGY-MEDICATION SAFETY SCREENING (VERIFIED INN / CATALOG DATA ONLY)
// ============================================================================

type DrugSafetyClass =
  | 'penicillin'
  | 'cephalosporin'
  | 'beta_lactamase_inhibitor'
  | 'nsaid'
  | 'sulfonamide'
  | 'dhfr_inhibitor'
  | 'biguanide'
  | 'sulfonylurea'
  | 'ccb'
  | 'statin'
  | 'arb'
  | 'beta_blocker'
  | 'thyroid'
  | 'vitamin_d'
  | 'inhaled_corticosteroid'
  | 'laba'
  | 'saba'
  | 'insulin'
  | 'ppi'
  | 'warfarin'
  | 'acetaminophen'
  | 'macrolide'
  | 'fluoroquinolone'
  | 'antiplatelet'
  | 'loop_diuretic'
  | 'dpp4'
  | 'dmard'
  | 'bisphosphonate'
  | 'ace_inhibitor'
  | 'mra';

interface VerifiedInnProfile {
  canonicalInn: string;
  classes: DrugSafetyClass[];
  aliases: string[];
}

interface VerifiedCombinationProduct {
  canonicalProductName: string;
  brandAliases: string[];
  requiredIngredients: string[];
}

const VERIFIED_INN_PROFILES: VerifiedInnProfile[] = [
  // Penicillins & beta-lactamase inhibitors (each distinct molecule has its own canonical INN)
  {
    canonicalInn: 'amoxicillin',
    classes: ['penicillin'],
    aliases: ['amoxicillin', 'amoxicillin trihydrate', 'amoxil', 'أموكسيسيلين', 'اموكسيسيلين'],
  },
  {
    canonicalInn: 'clavulanic acid',
    classes: ['beta_lactamase_inhibitor'],
    aliases: ['clavulanate', 'clavulanic acid', 'clavulanate potassium', 'كلافولانات'],
  },
  {
    canonicalInn: 'ampicillin',
    classes: ['penicillin'],
    aliases: ['ampicillin', 'ampicillin sodium', 'أمبيسيلين', 'امبيسيلين'],
  },
  {
    canonicalInn: 'benzylpenicillin',
    classes: ['penicillin'],
    aliases: [
      'benzylpenicillin',
      'penicillin g',
      'benzathine penicillin',
      'benzathine benzylpenicillin',
      'procaine penicillin',
      'بنزيل بنسلين',
    ],
  },
  {
    canonicalInn: 'phenoxymethylpenicillin',
    classes: ['penicillin'],
    aliases: ['phenoxymethylpenicillin', 'penicillin v', 'فينوكسي ميثيل بنسلين'],
  },
  {
    canonicalInn: 'piperacillin',
    classes: ['penicillin'],
    aliases: ['piperacillin', 'piperacillin sodium', 'بيبيراسيلين'],
  },
  {
    canonicalInn: 'tazobactam',
    classes: ['beta_lactamase_inhibitor'],
    aliases: ['tazobactam', 'tazobactam sodium', 'تازوباكتام'],
  },
  {
    canonicalInn: 'flucloxacillin',
    classes: ['penicillin'],
    aliases: ['flucloxacillin', 'flucloxacillin sodium', 'فلوكلوكساسيلين'],
  },
  {
    canonicalInn: 'cloxacillin',
    classes: ['penicillin'],
    aliases: ['cloxacillin', 'cloxacillin sodium', 'كلوكساسيلين'],
  },
  // Cephalosporins
  {
    canonicalInn: 'cephalexin',
    classes: ['cephalosporin'],
    aliases: ['cephalexin', 'cefalexin', 'keflex', 'سيفالكسين'],
  },
  {
    canonicalInn: 'ceftriaxone',
    classes: ['cephalosporin'],
    aliases: ['ceftriaxone', 'ceftriaxone sodium', 'rocephin', 'سيفترياكسون'],
  },
  {
    canonicalInn: 'cefixime',
    classes: ['cephalosporin'],
    aliases: ['cefixime', 'suprax', 'سيفيكسيم'],
  },
  {
    canonicalInn: 'cefuroxime',
    classes: ['cephalosporin'],
    aliases: ['cefuroxime', 'cefuroxime axetil', 'zinnat'],
  },
  // NSAIDs & Aspirin (each distinct INN modeled separately)
  {
    canonicalInn: 'aspirin',
    classes: ['nsaid'],
    aliases: ['aspirin', 'acetylsalicylic acid', 'asa', 'أسبرين', 'اسبرين'],
  },
  {
    canonicalInn: 'ibuprofen',
    classes: ['nsaid'],
    aliases: ['ibuprofen', 'brufen', 'advil', 'إيبوبروفين', 'ايبوبروفين', 'بروفين'],
  },
  {
    canonicalInn: 'diclofenac',
    classes: ['nsaid'],
    aliases: [
      'diclofenac',
      'diclofenac sodium',
      'diclofenac potassium',
      'voltaren',
      'olfen',
      'ديكلوفيناك',
      'فولتارين',
    ],
  },
  {
    canonicalInn: 'naproxen',
    classes: ['nsaid'],
    aliases: ['naproxen', 'naproxen sodium', 'نابروكسين'],
  },
  {
    canonicalInn: 'meloxicam',
    classes: ['nsaid'],
    aliases: ['meloxicam', 'mobic'],
  },
  {
    canonicalInn: 'mefenamic acid',
    classes: ['nsaid'],
    aliases: ['mefenamic', 'mefenamic acid', 'ponstan'],
  },
  {
    canonicalInn: 'ketoprofen',
    classes: ['nsaid'],
    aliases: ['ketoprofen', 'كيتوبروفين'],
  },
  {
    canonicalInn: 'ketorolac',
    classes: ['nsaid'],
    aliases: ['ketorolac', 'ketorolac tromethamine', 'كيتورولاك'],
  },
  {
    canonicalInn: 'indomethacin',
    classes: ['nsaid'],
    aliases: ['indomethacin', 'indometacin', 'إندوميثاسين'],
  },
  {
    canonicalInn: 'piroxicam',
    classes: ['nsaid'],
    aliases: ['piroxicam', 'بيروكسيكام'],
  },
  // Sulfonamides (each molecule distinct; nonspecific "sulfa"/"sulfonamides" excluded) & Trimethoprim
  {
    canonicalInn: 'sulfamethoxazole',
    classes: ['sulfonamide'],
    aliases: ['sulfamethoxazole', 'سلفاميثوكسازول'],
  },
  {
    canonicalInn: 'sulfadiazine',
    classes: ['sulfonamide'],
    aliases: ['sulfadiazine', 'سلفاديازين'],
  },
  {
    canonicalInn: 'sulfasalazine',
    classes: ['sulfonamide'],
    aliases: ['sulfasalazine', 'سلفاسالازين'],
  },
  {
    canonicalInn: 'trimethoprim',
    classes: ['dhfr_inhibitor'],
    aliases: ['trimethoprim', 'تريميثوبريم'],
  },
  // Antidiabetics & Insulins (nonspecific "insulin" excluded; glargine is explicit)
  {
    canonicalInn: 'metformin hcl',
    classes: ['biguanide'],
    aliases: ['metformin', 'metformin hcl', 'glucophage', 'ميتفورمين', 'غلوكوفاج'],
  },
  {
    canonicalInn: 'sitagliptin',
    classes: ['dpp4'],
    aliases: ['sitagliptin', 'januvia', 'سيتاغليبتين'],
  },
  {
    canonicalInn: 'glyburide',
    classes: ['sulfonylurea'],
    aliases: ['glyburide', 'glibenclamide', 'daonil', 'غليبنكلاميد'],
  },
  {
    canonicalInn: 'insulin glargine',
    classes: ['insulin'],
    aliases: ['insulin glargine', 'lantus', 'lantus solostar', 'glargine', 'أنسولين غلارجين'],
  },
  // Cardiovascular / Chronic-care INNs (each ACE inhibitor distinct)
  {
    canonicalInn: 'amlodipine besylate',
    classes: ['ccb'],
    aliases: ['amlodipine', 'amlodipine besylate', 'norvasc', 'أملوديبين'],
  },
  {
    canonicalInn: 'atorvastatin',
    classes: ['statin'],
    aliases: ['atorvastatin', 'lipitor', 'أتورفاستاتين'],
  },
  {
    canonicalInn: 'rosuvastatin',
    classes: ['statin'],
    aliases: ['rosuvastatin', 'crestor', 'روسوفاستاتين'],
  },
  {
    canonicalInn: 'losartan potassium',
    classes: ['arb'],
    aliases: ['losartan', 'losartan potassium', 'cozaar', 'لوسارتان'],
  },
  {
    canonicalInn: 'bisoprolol fumarate',
    classes: ['beta_blocker'],
    aliases: ['bisoprolol', 'bisoprolol fumarate', 'concor', 'بيسوبرولول'],
  },
  {
    canonicalInn: 'enalapril',
    classes: ['ace_inhibitor'],
    aliases: ['enalapril', 'enalapril maleate', 'إينالابريل'],
  },
  {
    canonicalInn: 'ramipril',
    classes: ['ace_inhibitor'],
    aliases: ['ramipril', 'راميبريل'],
  },
  {
    canonicalInn: 'lisinopril',
    classes: ['ace_inhibitor'],
    aliases: ['lisinopril', 'ليزينوبريل'],
  },
  {
    canonicalInn: 'captopril',
    classes: ['ace_inhibitor'],
    aliases: ['captopril', 'كابتوبريل'],
  },
  {
    canonicalInn: 'spironolactone',
    classes: ['mra'],
    aliases: ['spironolactone', 'aldactone', 'سبيرونولاكتون'],
  },
  {
    canonicalInn: 'clopidogrel',
    classes: ['antiplatelet'],
    aliases: ['clopidogrel', 'plavix', 'كلوبيدوغريل'],
  },
  {
    canonicalInn: 'furosemide',
    classes: ['loop_diuretic'],
    aliases: ['furosemide', 'lasix', 'فيوروسيميد'],
  },
  {
    canonicalInn: 'warfarin sodium',
    classes: ['warfarin'],
    aliases: ['warfarin', 'warfarin sodium', 'marevan', 'وارفارين'],
  },
  // Endocrine, Respiratory, GI, Analgesics & Anti-infectives
  {
    canonicalInn: 'levothyroxine sodium',
    classes: ['thyroid'],
    aliases: ['levothyroxine', 'levothyroxine sodium', 'euthyrox', 'ليفوثيروكسين'],
  },
  {
    canonicalInn: 'alfacalcidol',
    classes: ['vitamin_d'],
    aliases: ['alfacalcidol', 'one alpha', 'one-alpha', 'ألفاكالسيدول'],
  },
  {
    canonicalInn: 'budesonide',
    classes: ['inhaled_corticosteroid'],
    aliases: ['budesonide', 'pulmicort', 'بوديزونيد'],
  },
  {
    canonicalInn: 'formoterol',
    classes: ['laba'],
    aliases: ['formoterol', 'formoterol fumarate', 'foradil', 'فورموتيرول'],
  },
  {
    canonicalInn: 'salbutamol',
    classes: ['saba'],
    aliases: ['salbutamol', 'albuterol', 'ventolin', 'سالبوتامول', 'فنتولين'],
  },
  {
    canonicalInn: 'omeprazole',
    classes: ['ppi'],
    aliases: ['omeprazole', 'losec', 'أوميبرازول'],
  },
  {
    canonicalInn: 'paracetamol',
    classes: ['acetaminophen'],
    aliases: ['paracetamol', 'acetaminophen', 'panadol', 'باراسيتامول'],
  },
  {
    canonicalInn: 'azithromycin',
    classes: ['macrolide'],
    aliases: ['azithromycin', 'zithromax', 'أزيثرومايسين'],
  },
  {
    canonicalInn: 'ciprofloxacin',
    classes: ['fluoroquinolone'],
    aliases: ['ciprofloxacin', 'ciprobay', 'سيبروفلوكساسين'],
  },
  {
    canonicalInn: 'methotrexate',
    classes: ['dmard'],
    aliases: ['methotrexate', 'ميثوتريكسات'],
  },
  {
    canonicalInn: 'alendronic acid',
    classes: ['bisphosphonate'],
    aliases: ['alendronate', 'alendronic acid', 'fosamax'],
  },
];

// Multi-ingredient combination products: ALWAYS expand to ALL active ingredients so
// brand-only entry or partial generic entry never masks a hidden secondary ingredient.
const VERIFIED_COMBINATION_PRODUCTS: VerifiedCombinationProduct[] = [
  {
    canonicalProductName: 'Janumet (Sitagliptin / Metformin HCl)',
    brandAliases: ['janumet', 'janumet xr', 'جانوميت'],
    requiredIngredients: ['sitagliptin', 'metformin hcl'],
  },
  {
    canonicalProductName: 'Augmentin (Amoxicillin / Clavulanic Acid)',
    brandAliases: [
      'augmentin',
      'co-amoxiclav',
      'co amoxiclav',
      'amoclan',
      'klavox',
      'megamox',
      'أوغمنتين',
      'أوجمنتين',
      'اوجمنتين',
    ],
    requiredIngredients: ['amoxicillin', 'clavulanic acid'],
  },
  {
    canonicalProductName: 'Tazocin (Piperacillin / Tazobactam)',
    brandAliases: ['tazocin', 'تازوسين'],
    requiredIngredients: ['piperacillin', 'tazobactam'],
  },
  {
    canonicalProductName: 'Co-trimoxazole (Trimethoprim / Sulfamethoxazole)',
    brandAliases: [
      'co-trimoxazole',
      'co trimoxazole',
      'cotrimoxazole',
      'bactrim',
      'septrin',
      'باكتريم',
      'سبترين',
    ],
    requiredIngredients: ['trimethoprim', 'sulfamethoxazole'],
  },
  {
    canonicalProductName: 'Symbicort (Budesonide / Formoterol)',
    brandAliases: ['symbicort', 'symbicort turbuhaler', 'سيمبيكورت'],
    requiredIngredients: ['budesonide', 'formoterol'],
  },
  {
    canonicalProductName: 'Glucovance (Glyburide / Metformin HCl)',
    brandAliases: ['glucovance', 'غلوكوفانس'],
    requiredIngredients: ['glyburide', 'metformin hcl'],
  },
];

// Broad explicit therapeutic-class allergy labels modeled separately from canonical INNs
const BROAD_CLASS_ALLERGY_LABELS: Array<{
  drugClass: DrugSafetyClass;
  labels: string[];
  mode: 'confirmed_class_allergy' | 'nonspecific_class_caution';
}> = [
  {
    drugClass: 'penicillin',
    labels: ['penicillin', 'penicillins', 'بنسلين', 'beta-lactam', 'beta lactam'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'cephalosporin',
    labels: ['cephalosporin', 'cephalosporins', 'سيفالوسبورين', 'beta-lactam', 'beta lactam'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'nsaid',
    labels: ['nsaid', 'nsaids', 'مضادات الالتهاب غير الستيرويدية'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'nsaid',
    labels: [
      'مسكنات',
      'مسكن',
      'مسكنات ألم',
      'مسكنات الالم',
      'مسكنات الألم',
      'painkiller',
      'painkillers',
      'pain killer',
      'pain killers',
      'analgesic',
      'analgesics',
    ],
    mode: 'nonspecific_class_caution',
  },
  {
    drugClass: 'acetaminophen',
    labels: [
      'مسكنات',
      'مسكن',
      'مسكنات ألم',
      'مسكنات الالم',
      'مسكنات الألم',
      'painkiller',
      'painkillers',
      'pain killer',
      'pain killers',
      'analgesic',
      'analgesics',
    ],
    mode: 'nonspecific_class_caution',
  },
  {
    drugClass: 'sulfonamide',
    labels: ['sulfonamide', 'sulfonamides', 'سلفوناميد'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'sulfonamide',
    labels: ['sulfa', 'سلفا'],
    mode: 'nonspecific_class_caution',
  },
  {
    drugClass: 'biguanide',
    labels: ['biguanide'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'sulfonylurea',
    labels: ['sulfonylurea'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'ccb',
    labels: ['dihydropyridine'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'statin',
    labels: ['statin', 'statins'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'arb',
    labels: ['arb'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'beta_blocker',
    labels: ['beta blocker'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'inhaled_corticosteroid',
    labels: ['corticosteroid', 'steroid', 'steroids', 'كورتيزون', 'كورتيكوستيرويد'],
    mode: 'nonspecific_class_caution',
  },
  {
    drugClass: 'insulin',
    labels: ['insulin', 'أنسولين', 'انسولين'],
    mode: 'nonspecific_class_caution',
  },
  {
    drugClass: 'macrolide',
    labels: ['macrolide'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'fluoroquinolone',
    labels: ['fluoroquinolone'],
    mode: 'confirmed_class_allergy',
  },
  {
    drugClass: 'ace_inhibitor',
    labels: ['ace inhibitor', 'ace inhibitors'],
    mode: 'confirmed_class_allergy',
  },
];

// Separate drug-class cross-reactivity matrix: cross-class OR distinct INNs within
// the same class produce class-level possible cross-reactivity cautions rather than
// automatically masquerading as confirmed same-ingredient conflicts.
interface DrugClassRelationship {
  sourceClass: DrugSafetyClass;
  targetClass: DrugSafetyClass;
  note: string;
}

const DRUG_CLASS_CROSS_REACTIVITY: DrugClassRelationship[] = [
  {
    sourceClass: 'penicillin',
    targetClass: 'cephalosporin',
    note: 'Beta-lactam cross-reactivity caution (Penicillin / Cephalosporin)',
  },
  {
    sourceClass: 'nsaid',
    targetClass: 'nsaid',
    note: 'NSAID COX-1 class cross-reactivity caution between distinct NSAID agents',
  },
  {
    sourceClass: 'ace_inhibitor',
    targetClass: 'ace_inhibitor',
    note: 'ACE-inhibitor class caution (angioedema/cough cross-sensitivity risk)',
  },
  {
    sourceClass: 'penicillin',
    targetClass: 'penicillin',
    note: 'Penicillin class cross-reactivity between distinct penicillin molecules',
  },
  {
    sourceClass: 'cephalosporin',
    targetClass: 'cephalosporin',
    note: 'Cephalosporin class cross-reactivity caution between distinct agents',
  },
  {
    sourceClass: 'sulfonamide',
    targetClass: 'sulfonamide',
    note: 'Sulfonamide class caution between distinct sulfonamide agents',
  },
  {
    sourceClass: 'sulfonamide',
    targetClass: 'loop_diuretic',
    note: 'Nonspecific sulfa-moiety cross-reactivity caution (non-antibiotic sulfonamide)',
  },
  {
    sourceClass: 'sulfonamide',
    targetClass: 'sulfonylurea',
    note: 'Nonspecific sulfa-moiety cross-reactivity caution (non-antibiotic sulfonamide)',
  },
  {
    sourceClass: 'statin',
    targetClass: 'statin',
    note: 'HMG-CoA reductase inhibitor class caution between distinct statins',
  },
];

function normalizeMatchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[()[\]{},._/+\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitDeclaredIngredients(rawGeneric: string): string[] {
  return rawGeneric
    .split(/[/+,;&]+|\s+(?:and|with|و)\s+/i)
    .map((part) => normalizeMatchText(part))
    .filter(Boolean);
}

function findProfileForPhrase(phrase: string): VerifiedInnProfile | undefined {
  if (!phrase) return undefined;
  let bestMatch: { profile: VerifiedInnProfile; aliasLen: number } | undefined;
  for (const profile of VERIFIED_INN_PROFILES) {
    for (const alias of profile.aliases) {
      const normAlias = normalizeMatchText(alias);
      if (!normAlias || normAlias.length < 3) continue;
      if (phrase === normAlias || ` ${phrase} `.includes(` ${normAlias} `)) {
        if (!bestMatch || normAlias.length > bestMatch.aliasLen) {
          bestMatch = { profile, aliasLen: normAlias.length };
        }
      }
    }
  }
  return bestMatch?.profile;
}

function findExactInnProfile(phrase: string): VerifiedInnProfile | undefined {
  if (!phrase) return undefined;
  for (const profile of VERIFIED_INN_PROFILES) {
    if (normalizeMatchText(profile.canonicalInn) === phrase) {
      return profile;
    }
    for (const alias of profile.aliases) {
      const normAlias = normalizeMatchText(alias);
      if (normAlias.length >= 3 && normAlias === phrase) {
        return profile;
      }
    }
  }
  return undefined;
}

function findComboProducts(texts: string[]): VerifiedCombinationProduct[] {
  const matched: VerifiedCombinationProduct[] = [];
  for (const combo of VERIFIED_COMBINATION_PRODUCTS) {
    if (
      combo.brandAliases.some((alias) => {
        const normAlias = normalizeMatchText(alias);
        return (
          normAlias.length >= 3 &&
          texts.some((t) => t === normAlias || ` ${t} `.includes(` ${normAlias} `))
        );
      })
    ) {
      matched.push(combo);
    }
  }
  return matched;
}

type ComboBrandMatchType = 'exact_brand' | 'harmless_suffix_brand';

function findVerifiedComboBrandMatches(
  normBrand: string,
  strippedBrand: string
): Array<{ combo: VerifiedCombinationProduct; matchType: ComboBrandMatchType }> {
  if (!normBrand) return [];
  const matches: Array<{ combo: VerifiedCombinationProduct; matchType: ComboBrandMatchType }> = [];
  for (const combo of VERIFIED_COMBINATION_PRODUCTS) {
    let matchType: ComboBrandMatchType | undefined;
    for (const alias of combo.brandAliases) {
      const normAlias = normalizeMatchText(alias);
      if (normAlias.length < 3) continue;
      if (normBrand === normAlias) {
        matchType = 'exact_brand';
        break;
      }
      if (strippedBrand.length > 0 && strippedBrand === normAlias) {
        matchType = 'harmless_suffix_brand';
      }
    }
    if (matchType) {
      matches.push({ combo, matchType });
    }
  }
  return matches;
}

interface IngredientCoverageResolution {
  screeningProfiles: VerifiedInnProfile[];
  verifiedIngredients: string[];
  unverifiedIngredients: string[];
  missingComboIngredients: string[];
  brandContradictsDeclared: boolean;
  hasFullIngredientCoverage: boolean;
}

function stripHarmlessBrandTokens(normBrand: string): string {
  return normBrand
    .replace(
      /\b(\d+(?:\.\d+)?|mg|mcg|ug|g|ml|iu|xr|sr|er|cr|mr|dr|xl|hd|la|hcl|sodium|potassium|besylate|fumarate|maleate|tartrate|tromethamine|trihydrate|tablet|tablets|capsule|capsules|syrup|inhaler|turbuhaler|solostar)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCatalogRecordVerified(entry: MedicationCatalogItem): boolean {
  return (
    entry.ingredientVerificationStatus === 'verified' &&
    Array.isArray(entry.activeIngredients) &&
    entry.activeIngredients.length > 0 &&
    entry.activeIngredients.every((ing) => {
      if (typeof ing !== 'string' || ing.trim().length === 0) return false;
      const normIng = normalizeMatchText(ing);
      return Boolean(normIng && findExactInnProfile(normIng));
    })
  );
}

export interface MedicationAllergyRiskOptions {
  authoritativeCatalogOnly?: boolean;
  catalogLookupFailed?: boolean;
}

function resolveMedicationIngredientCoverage(
  med: {
    catalogId?: string;
    catalogRecord?: MedicationCatalogItem;
    brandName: string;
    genericName: string;
  },
  options?: MedicationAllergyRiskOptions
): IngredientCoverageResolution {
  const normBrand = normalizeMatchText(med.brandName);
  const strippedBrand = normBrand ? stripHarmlessBrandTokens(normBrand) : '';
  const normGeneric = normalizeMatchText(med.genericName);
  const declaredParts = splitDeclaredIngredients(med.genericName);

  const authoritativeCatalogOnly = options?.authoritativeCatalogOnly === true;
  const catalogLookupFailed = options?.catalogLookupFailed === true;
  const hasCatalogRef = Boolean(med.catalogId || med.catalogRecord);
  const catalogEntry =
    med.catalogRecord ??
    (!authoritativeCatalogOnly && med.catalogId
      ? MEDICATION_CATALOG.find((c) => c.id === med.catalogId)
      : undefined);

  const catalogStatusVerified = Boolean(catalogEntry && isCatalogRecordVerified(catalogEntry));
  const hasMissingAuthoritativeCatalog =
    authoritativeCatalogOnly && Boolean(med.catalogId) && !catalogEntry;
  const hasUnverifiedCatalogRecord =
    hasCatalogRef && (!catalogStatusVerified || hasMissingAuthoritativeCatalog);

  const catalogBrandOrGenericMatches =
    Boolean(catalogEntry) &&
    ((normBrand.length > 0 && normalizeMatchText(catalogEntry!.brandName) === normBrand) ||
      (normBrand.length === 0 &&
        normGeneric.length > 0 &&
        normalizeMatchText(catalogEntry!.genericName) === normGeneric));

  const catalogMatchesInput = catalogStatusVerified && catalogBrandOrGenericMatches;
  const hasCatalogMismatch = hasCatalogRef && Boolean(catalogEntry) && !catalogBrandOrGenericMatches;

  const declaredProfiles: VerifiedInnProfile[] = [];
  const unverifiedIngredients: string[] = [];
  for (const part of declaredParts) {
    const prof = findProfileForPhrase(part);
    if (prof) {
      if (!declaredProfiles.includes(prof)) declaredProfiles.push(prof);
    } else {
      unverifiedIngredients.push(part);
    }
  }

  const brandProfiles: VerifiedInnProfile[] = [];
  let brandExactVerified = false;
  if (normBrand) {
    for (const profile of VERIFIED_INN_PROFILES) {
      for (const alias of profile.aliases) {
        const normAlias = normalizeMatchText(alias);
        if (!normAlias || normAlias.length < 3) continue;
        if (normBrand === normAlias || ` ${normBrand} `.includes(` ${normAlias} `)) {
          if (!brandProfiles.includes(profile)) brandProfiles.push(profile);
        }
        if (
          normBrand === normAlias ||
          (strippedBrand.length > 0 && strippedBrand === normAlias)
        ) {
          brandExactVerified = true;
        }
      }
    }
  }

  const comboSearchTexts = [
    normBrand,
    normGeneric,
    catalogBrandOrGenericMatches && catalogEntry ? normalizeMatchText(catalogEntry.brandName) : '',
    catalogBrandOrGenericMatches && catalogEntry ? normalizeMatchText(catalogEntry.genericName) : '',
  ].filter(Boolean);

  // Word-boundary screening expands combination components even on extended brand names
  // so direct allergies to hidden components are still caught.
  const matchedCombos = findComboProducts(comboSearchTexts);
  // Only exact combination brand matches or explicitly approved harmless suffixes grant
  // formulation-completeness verification (e.g. "Janumet Mystery" does NOT qualify).
  const verifiedComboBrandMatches = normBrand
    ? findVerifiedComboBrandMatches(normBrand, strippedBrand)
    : [];
  const comboExactVerified = verifiedComboBrandMatches.length > 0;

  const requiredComboIngredients = new Set<string>();
  for (const combo of matchedCombos) {
    for (const req of combo.requiredIngredients) {
      requiredComboIngredients.add(req);
    }
  }

  const catalogInns = new Set<string>();
  const catalogScreeningProfiles: VerifiedInnProfile[] = [];
  const unrecognizedCatalogIngredients: string[] = [];
  if (catalogEntry?.activeIngredients && catalogEntry.activeIngredients.length > 0) {
    for (const ing of catalogEntry.activeIngredients) {
      const normIng = typeof ing === 'string' ? normalizeMatchText(ing) : '';
      const exactProf = normIng ? findExactInnProfile(normIng) : undefined;
      if (exactProf) {
        if (catalogBrandOrGenericMatches) {
          requiredComboIngredients.add(exactProf.canonicalInn);
          catalogInns.add(exactProf.canonicalInn);
        } else {
          // Even if catalog brand mismatches input, keep screening recognizable ingredients.
          catalogScreeningProfiles.push(exactProf);
        }
      } else {
        if (catalogBrandOrGenericMatches) {
          unrecognizedCatalogIngredients.push(`unrecognized_catalog:${normIng || 'blank'}`);
        }
        // Preserve conflict screening for any recognizable sub-components in malformed entries.
        for (const subPart of splitDeclaredIngredients(typeof ing === 'string' ? ing : '')) {
          const fallbackProf = findProfileForPhrase(subPart);
          if (fallbackProf) {
            catalogScreeningProfiles.push(fallbackProf);
          }
        }
      }
    }
  }

  const screeningProfileSet = new Set<VerifiedInnProfile>([
    ...declaredProfiles,
    ...brandProfiles,
    ...catalogScreeningProfiles,
  ]);
  const missingComboIngredients: string[] = [];

  for (const reqInn of requiredComboIngredients) {
    const reqProfile = VERIFIED_INN_PROFILES.find((p) => p.canonicalInn === reqInn);
    if (reqProfile) {
      screeningProfileSet.add(reqProfile);
    }
    if (!declaredProfiles.some((dp) => dp.canonicalInn === reqInn)) {
      missingComboIngredients.push(reqInn);
    }
  }

  // Detect contradictory brand-vs-generic or catalog-vs-declared INN mismatches
  const catalogContradictsDeclared =
    catalogBrandOrGenericMatches &&
    catalogInns.size > 0 &&
    declaredProfiles.some((dp) => !catalogInns.has(dp.canonicalInn));

  const brandContradictsDeclared =
    catalogContradictsDeclared ||
    (declaredProfiles.length > 0 &&
      brandProfiles.length > 0 &&
      brandProfiles.some(
        (bp) => !declaredProfiles.some((dp) => dp.canonicalInn === bp.canonicalInn)
      ));

  // Detect suspicious uncatalogued combo brand naming without full verified components
  const brandSuggestsCombination =
    /\b(plus|comp|compound|co-|forte|duo|max)\b|[+/]/i.test(med.brandName) &&
    !comboExactVerified &&
    !catalogMatchesInput &&
    declaredProfiles.length < 2;

  // Fail-closed shared formulation completeness rule:
  // If a brand name is provided, we MUST have reliable formulation evidence
  // (fully verified catalog record matching brand, exact/approved-suffix combination product,
  // or exact/approved-suffix single-agent brand/INN). Unrecognized extensions like
  // "Janumet Mystery" NEVER grant formulation completeness.
  const hasBrandFormulationEvidence =
    !normBrand ||
    comboExactVerified ||
    catalogMatchesInput ||
    brandExactVerified;

  const extraUnverifiedFlags: string[] = [...unrecognizedCatalogIngredients];
  if (catalogLookupFailed) {
    extraUnverifiedFlags.push('authoritative_catalog_unavailable');
  }
  if (hasMissingAuthoritativeCatalog) {
    extraUnverifiedFlags.push('missing_authoritative_catalog_record');
  }
  if (hasUnverifiedCatalogRecord && !hasMissingAuthoritativeCatalog) {
    extraUnverifiedFlags.push('unverified_catalog_record');
  }
  if (hasCatalogMismatch) {
    extraUnverifiedFlags.push('catalog_record_mismatch');
  }
  if (normBrand && !hasBrandFormulationEvidence && !brandContradictsDeclared) {
    extraUnverifiedFlags.push('unrecognized_brand_formulation');
  }
  if (brandContradictsDeclared) {
    extraUnverifiedFlags.push('brand_generic_mismatch');
  }

  const hasFullIngredientCoverage =
    !catalogLookupFailed &&
    !hasMissingAuthoritativeCatalog &&
    declaredProfiles.length > 0 &&
    unverifiedIngredients.length === 0 &&
    missingComboIngredients.length === 0 &&
    unrecognizedCatalogIngredients.length === 0 &&
    !brandContradictsDeclared &&
    !hasUnverifiedCatalogRecord &&
    !hasCatalogMismatch &&
    hasBrandFormulationEvidence &&
    !brandSuggestsCombination;

  return {
    screeningProfiles: Array.from(screeningProfileSet),
    verifiedIngredients: Array.from(screeningProfileSet).map((p) => p.canonicalInn),
    unverifiedIngredients: [
      ...unverifiedIngredients,
      ...missingComboIngredients.map((m) => `missing:${m}`),
      ...extraUnverifiedFlags,
    ],
    missingComboIngredients,
    brandContradictsDeclared,
    hasFullIngredientCoverage,
  };
}

interface AllergySubstanceResolution {
  specificInns: VerifiedInnProfile[];
  confirmedBroadClasses: DrugSafetyClass[];
  nonspecificCautionClasses: DrugSafetyClass[];
}

function resolveAllergySubstance(allergy: PatientAllergy): AllergySubstanceResolution {
  const normSub = normalizeMatchText(allergy.substance);
  if (!normSub) {
    return { specificInns: [], confirmedBroadClasses: [], nonspecificCautionClasses: [] };
  }

  const specificInns: VerifiedInnProfile[] = [];
  const padded = ` ${normSub} `;

  // Check if allergy names any verified single-agent INN(s)
  for (const profile of VERIFIED_INN_PROFILES) {
    for (const alias of profile.aliases) {
      const normAlias = normalizeMatchText(alias);
      if (normAlias.length >= 3 && (normSub === normAlias || padded.includes(` ${normAlias} `))) {
        if (!specificInns.includes(profile)) specificInns.push(profile);
        break;
      }
    }
  }

  // Check if allergy names any verified combination brand (e.g., "Augmentin" or "Bactrim")
  const matchedCombos = findComboProducts([normSub]);
  for (const combo of matchedCombos) {
    for (const reqInn of combo.requiredIngredients) {
      const prof = VERIFIED_INN_PROFILES.find((p) => p.canonicalInn === reqInn);
      if (prof && !specificInns.includes(prof)) {
        specificInns.push(prof);
      }
    }
  }

  const confirmedBroadClasses: DrugSafetyClass[] = [];
  const nonspecificCautionClasses: DrugSafetyClass[] = [];
  for (const rule of BROAD_CLASS_ALLERGY_LABELS) {
    const matchesLabel = rule.labels.some((lbl) => {
      const normLbl = normalizeMatchText(lbl);
      return normLbl.length >= 3 && (normSub === normLbl || padded.includes(` ${normLbl} `));
    });
    if (!matchesLabel) continue;
    if (rule.mode === 'confirmed_class_allergy') {
      if (!confirmedBroadClasses.includes(rule.drugClass)) {
        confirmedBroadClasses.push(rule.drugClass);
      }
    } else {
      if (!nonspecificCautionClasses.includes(rule.drugClass)) {
        nonspecificCautionClasses.push(rule.drugClass);
      }
    }
  }

  return { specificInns, confirmedBroadClasses, nonspecificCautionClasses };
}

const NONSPECIFIC_DIRECT_IGNORE_TOKENS = new Set([
  'sulfa',
  'sulfonamide',
  'sulfonamides',
  'penicillin',
  'penicillins',
  'cephalosporin',
  'cephalosporins',
  'nsaid',
  'nsaids',
  'insulin',
  'steroid',
  'steroids',
  'painkiller',
  'painkillers',
  'analgesic',
  'analgesics',
  'statin',
  'statins',
  'acid',
  'sodium',
  'potassium',
  'hcl',
  'maleate',
  'fumarate',
  'besylate',
  'tromethamine',
  'سلفا',
  'سلفوناميد',
  'بنسلين',
  'أنسولين',
  'انسولين',
  'مسكنات',
  'مسكن',
  'كورتيزون',
  'كورتيكوستيرويد',
]);

function hasDirectUnprofiledSubstanceMatch(
  allergy: PatientAllergy,
  med: { brandName: string; genericName: string },
  expandedIngredients: string[] = []
): boolean {
  const allergyTokens = normalizeMatchText(allergy.substance)
    .split(' ')
    .filter((t) => t.length >= 4 && !NONSPECIFIC_DIRECT_IGNORE_TOKENS.has(t));
  const medText = ` ${normalizeMatchText(
    `${med.genericName} ${med.brandName} ${expandedIngredients.join(' ')}`
  )} `;
  return allergyTokens.some((tok) => medText.includes(` ${tok} `));
}

export type AllergyRiskLevel =
  | 'critical_conflict'
  | 'allergy_conflict'
  | 'caution_cross_reactivity'
  | 'insufficient_ingredient_data'
  | 'incomplete_allergy_data'
  | 'no_documented_allergies'
  | 'no_known_conflict_verified';

export function toAllergyOverrideLevel(
  level: AllergyRiskLevel
): AllergyOverrideAuthorization['level'] {
  switch (level) {
    case 'critical_conflict':
    case 'allergy_conflict':
    case 'caution_cross_reactivity':
    case 'insufficient_ingredient_data':
      return level;
    default:
      return undefined;
  }
}

export type AllergyConflictCategory =
  | 'recognized_critical'
  | 'possible_conflict'
  | 'unknown_ingredient_coverage'
  | 'non_severe_conflict'
  | 'incomplete_chart'
  | 'verified_clear';

export interface AllergyRiskAssessment {
  level: AllergyRiskLevel;
  conflictCategory: AllergyConflictCategory;
  severityTone: 'critical' | 'warning' | 'neutral';
  hasSeverePatientAllergies: boolean;
  requiresPharmacistAcknowledgment: boolean;
  requiresDocumentedReview: boolean;
  requiresDocumentedOverride: boolean;
  patientLabel: string;
  medicationLabel: string;
  matchedAllergies: PatientAllergy[];
  incompleteAllergies: PatientAllergy[];
  verifiedIngredients: string[];
  unverifiedIngredients: string[];
  title: string;
  message: string;
  acknowledgmentLabel?: string;
}

export function assessMedicationAllergyRisk(
  patient: Patient,
  medication: {
    catalogId?: string;
    catalogRecord?: MedicationCatalogItem;
    brandName: string;
    genericName: string;
    strength?: string;
  },
  lang: Language,
  options?: MedicationAllergyRiskOptions
): AllergyRiskAssessment {
  const isAr = lang === 'ar';
  const patientLabel = `${patient.fullName} (${patient.patientCode})`;
  const medTitle = [medication.brandName.trim(), medication.genericName.trim()]
    .filter(Boolean)
    .join(' / ');
  const medicationLabel = medication.strength?.trim()
    ? `${medTitle} — ${medication.strength.trim()}`
    : medTitle || (isAr ? 'دواء غير محدد' : 'Unspecified medication');

  const coverage = resolveMedicationIngredientCoverage(medication, options);
  const allergies = patient.allergies ?? [];
  const hasSeverePatientAllergies = allergies.some((a) => a.severity === 'severe');
  const incompleteAllergies = allergies.filter(
    (a) => a.substance.trim().length < 2 || !(a.reaction ?? '').trim()
  );

  // Case 1: Zero documented allergies -> never display "Safe"; show explicit neutral/amber verification notice
  if (allergies.length === 0) {
    return {
      level: 'no_documented_allergies',
      conflictCategory: 'incomplete_chart',
      severityTone: 'warning',
      hasSeverePatientAllergies: false,
      requiresPharmacistAcknowledgment: false,
      requiresDocumentedReview: false,
      requiresDocumentedOverride: false,
      patientLabel,
      medicationLabel,
      matchedAllergies: [],
      incompleteAllergies: [],
      verifiedIngredients: coverage.verifiedIngredients,
      unverifiedIngredients: coverage.unverifiedIngredients,
      title: isAr
        ? 'لا توجد حساسيات موثقة في ملف المراجع'
        : 'No Documented Allergies in Chart',
      message: isAr
        ? `المراجع ${patientLabel}: لم يتم توثيق حساسيات دوائية في الملف (عدم التوثيق لا يعني انتفاء الحساسية). تأكد شفهياً من تاريخ الحساسية قبل وصف أو صرف ${medicationLabel}.`
        : `Patient ${patientLabel}: Zero allergies recorded in chart (absence of documentation does not guarantee absence of allergy). Verify allergy history verbally before prescribing or dispensing ${medicationLabel}.`,
    };
  }

  const medInns = new Set<string>(coverage.screeningProfiles.map((p) => p.canonicalInn));
  const medClasses = new Set<DrugSafetyClass>();
  for (const p of coverage.screeningProfiles) {
    for (const c of p.classes) medClasses.add(c);
  }

  const confirmedConflicts: PatientAllergy[] = [];
  const crossReactiveCautions: PatientAllergy[] = [];

  for (const allergy of allergies) {
    const resolved = resolveAllergySubstance(allergy);

    // 1. Confirmed match ONLY if:
    //    (a) Exact canonical INN match (e.g. Enalapril allergy <-> Enalapril, Metformin <-> Janumet), OR
    //    (b) Documented explicit therapeutic-class allergy (e.g. "Penicillin", "NSAIDs", "Sulfonamides")
    //        where for "sulfonamide" broad class only antibacterial sulfamethoxazole/sulfadiazine
    //        count as confirmed class conflict (sulfasalazine / loop diuretic / sulfonylurea are class caution), OR
    //    (c) Direct verbatim token match when the allergy did NOT resolve to a different known INN
    const exactInnMatch = resolved.specificInns.some((sp) => medInns.has(sp.canonicalInn));
    const confirmedBroadClassMatch = resolved.confirmedBroadClasses.some((cls) => {
      if (cls === 'sulfonamide') {
        return medInns.has('sulfamethoxazole') || medInns.has('sulfadiazine');
      }
      return medClasses.has(cls);
    });
    const unprofiledDirectMatch =
      resolved.specificInns.length === 0 &&
      resolved.confirmedBroadClasses.length === 0 &&
      resolved.nonspecificCautionClasses.length === 0 &&
      hasDirectUnprofiledSubstanceMatch(allergy, medication, coverage.verifiedIngredients);

    if (exactInnMatch || confirmedBroadClassMatch || unprofiledDirectMatch) {
      confirmedConflicts.push(allergy);
      continue;
    }

    // 2. Class-based possible cross-reactivity / nonspecific allergy label caution:
    //    - Distinct canonical INNs sharing a class via DRUG_CLASS_CROSS_REACTIVITY
    //      (e.g., Ketoprofen <-> Ketorolac, Enalapril <-> Ramipril, Flucloxacillin <-> Cloxacillin,
    //      Aspirin <-> Ibuprofen, Sulfamethoxazole <-> Sulfasalazine)
    //    - Cross-class relationships (e.g. Penicillin <-> Cephalosporin)
    //    - Nonspecific allergy labels ("Sulfa", "Insulin", "Corticosteroid") matching class/linked target
    const allergyCandidateClasses = new Set<DrugSafetyClass>([
      ...resolved.specificInns.flatMap((sp) => sp.classes),
      ...resolved.confirmedBroadClasses,
      ...resolved.nonspecificCautionClasses,
    ]);

    const hasClassCrossReactivity =
      Array.from(allergyCandidateClasses).some((srcCls) =>
        DRUG_CLASS_CROSS_REACTIVITY.some(
          (rel) => rel.sourceClass === srcCls && medClasses.has(rel.targetClass)
        )
      ) ||
      resolved.nonspecificCautionClasses.some((cls) => medClasses.has(cls)) ||
      (resolved.confirmedBroadClasses.includes('sulfonamide') && medClasses.has('sulfonamide'));

    if (hasClassCrossReactivity) {
      crossReactiveCautions.push(allergy);
    }
  }

  // Case 2: Confirmed same-ingredient OR confirmed broad-class allergy conflict
  if (confirmedConflicts.length > 0) {
    const hasSevere = confirmedConflicts.some((a) => a.severity === 'severe');
    const allergyDesc = confirmedConflicts
      .map(
        (a) =>
          `${a.substance} [${a.severity}${a.reaction ? `: ${a.reaction}` : ''}]`
      )
      .join(' · ');

    if (hasSevere) {
      return {
        level: 'critical_conflict',
        conflictCategory: 'recognized_critical',
        severityTone: 'critical',
        hasSeverePatientAllergies,
        requiresPharmacistAcknowledgment: true,
        requiresDocumentedReview: true,
        requiresDocumentedOverride: true,
        patientLabel,
        medicationLabel,
        matchedAllergies: confirmedConflicts,
        incompleteAllergies,
        verifiedIngredients: coverage.verifiedIngredients,
        unverifiedIngredients: coverage.unverifiedIngredients,
        title: isAr
          ? 'تحذير حساسية حرج — تعارض شديد محتمل (Severe / Anaphylaxis)'
          : 'CRITICAL ALLERGY CONFLICT — SEVERE REACTION RISK',
        message: isAr
          ? `تعارض حرج للمراجع ${patientLabel} عند اختيار الدواء ${medicationLabel}. الحساسية المسجلة: ${allergyDesc}. أوقف المتابعة ما لم يكن هناك توجيه طبي موثق وتجاوز صيدلاني موثق بالتفاصيل.`
          : `Critical allergy conflict for ${patientLabel} with medication ${medicationLabel}. Recorded allergy: ${allergyDesc}. Do not proceed unless prescriber/pharmacist authorization evidence and clinical justification are explicitly documented.`,
        acknowledgmentLabel: isAr
          ? `أقر بتوثيق التحذير الحرج لحساسية المراجع ${patient.fullName} وتأكيد وجود موافقة وتبرير سريري موثق لدواء ${medication.brandName || medication.genericName}`
          : `I acknowledge the critical allergy warning for ${patient.fullName} and attest that prescriber/pharmacist override authorization is documented below`,
      };
    }

    return {
      level: 'allergy_conflict',
      conflictCategory: 'non_severe_conflict',
      severityTone: 'warning',
      hasSeverePatientAllergies,
      requiresPharmacistAcknowledgment: true,
      requiresDocumentedReview: hasSeverePatientAllergies,
      requiresDocumentedOverride: false,
      patientLabel,
      medicationLabel,
      matchedAllergies: confirmedConflicts,
      incompleteAllergies,
      verifiedIngredients: coverage.verifiedIngredients,
      unverifiedIngredients: coverage.unverifiedIngredients,
      title: isAr
        ? 'تنبيه تعارض حساسية دوائية'
        : 'Medication–Allergy Conflict Warning',
      message: isAr
        ? `تعارض محتمل للمراجع ${patientLabel} مع الدواء ${medicationLabel}. الحساسية المسجلة: ${allergyDesc}.`
        : `Potential allergy conflict for ${patientLabel} with ${medicationLabel}. Recorded allergy: ${allergyDesc}.`,
      acknowledgmentLabel: isAr
        ? `أؤكد مراجعة تنبيه الحساسية للمراجع ${patient.fullName} وتأكيد ملاءمة المتابعة`
        : `I confirm I have reviewed this allergy conflict for ${patient.fullName} and authorized proceeding`,
    };
  }

  // Case 3: Class-based cross-reactivity caution OR nonspecific allergy label warning
  if (crossReactiveCautions.length > 0) {
    const allergyDesc = crossReactiveCautions
      .map(
        (a) =>
          `${a.substance} [${a.severity}${a.reaction ? `: ${a.reaction}` : ''}]`
      )
      .join(' · ');
    const hasSevereCross = crossReactiveCautions.some((a) => a.severity === 'severe');
    return {
      level: 'caution_cross_reactivity',
      conflictCategory: 'possible_conflict',
      severityTone: hasSevereCross ? 'critical' : 'warning',
      hasSeverePatientAllergies,
      requiresPharmacistAcknowledgment: true,
      requiresDocumentedReview: hasSeverePatientAllergies || hasSevereCross,
      requiresDocumentedOverride: false,
      patientLabel,
      medicationLabel,
      matchedAllergies: crossReactiveCautions,
      incompleteAllergies,
      verifiedIngredients: coverage.verifiedIngredients,
      unverifiedIngredients: coverage.unverifiedIngredients,
      title: isAr
        ? 'تعارض محتمل على مستوى الفئة الدوائية / تفاعل متصالب'
        : 'Possible Class-Level Cross-Reactivity / Nonspecific Allergy Caution',
      message: isAr
        ? `تنبيه تفاعل متصالب محتمل للمراجع ${patientLabel} مع الدواء ${medicationLabel} (علاقة فئة دوائية أو تسمية غير محددة، وليس تطابقاً مؤكداً لنفس المادة الفعالة). الحساسية المسجلة: (${allergyDesc}). يلزم تقييم الصيدلي وتوثيق المراجعة السريرية قبل المتابعة.`
        : `Possible class-level cross-reactivity or nonspecific allergy caution for ${patientLabel} with ${medicationLabel} (distinct active ingredient sharing a therapeutic class or cross-reactivity risk, not a confirmed identical-ingredient match). Recorded allergy: (${allergyDesc}). Verify risk and document clinical review before proceeding.`,
      acknowledgmentLabel: isAr
        ? `أؤكد تقييم خطورة التفاعل المتصالب على مستوى الفئة الدوائية للمراجع ${patient.fullName} قبل المتابعة`
        : `I confirm class-level cross-reactivity assessment for ${patient.fullName} before proceeding`,
    };
  }

  // Case 4: Unrecognized OR incomplete multi-ingredient / partial INN verification
  if (!coverage.hasFullIngredientCoverage) {
    const documentedList = allergies.map((a) => a.substance).join(isAr ? '، ' : ', ');
    const category: AllergyConflictCategory = coverage.brandContradictsDeclared
      ? 'possible_conflict'
      : 'unknown_ingredient_coverage';
    const missingDetail =
      coverage.missingComboIngredients.length > 0
        ? isAr
          ? ` مكونات مركبة غير مذكورة بالكامل: (${coverage.missingComboIngredients.join('، ')}).`
          : ` Unverified/omitted combination ingredient(s): (${coverage.missingComboIngredients.join(', ')}).`
        : coverage.unverifiedIngredients.length > 0
          ? isAr
            ? ` مكونات لم يتم التحقق منها بالكامل: (${coverage.unverifiedIngredients.join('، ')}).`
            : ` Unverified ingredient component(s): (${coverage.unverifiedIngredients.join(', ')}).`
          : '';
    return {
      level: 'insufficient_ingredient_data',
      conflictCategory: category,
      severityTone: hasSeverePatientAllergies ? 'warning' : 'warning',
      hasSeverePatientAllergies,
      requiresPharmacistAcknowledgment: true,
      requiresDocumentedReview: hasSeverePatientAllergies,
      requiresDocumentedOverride: false,
      patientLabel,
      medicationLabel,
      matchedAllergies: [],
      incompleteAllergies,
      verifiedIngredients: coverage.verifiedIngredients,
      unverifiedIngredients: coverage.unverifiedIngredients,
      title: coverage.brandContradictsDeclared
        ? isAr
          ? 'تعارض محتمل بين الاسم التجاري والعلمي (مراجعة إلزامية)'
          : 'Possible Conflict — Brand/Generic Mismatch Requires Clinical Review'
        : isAr
          ? 'تغطية المكونات الفعالة غير معروفة / غير مكتملة (فحص يدوي إلزامي)'
          : 'Unknown Ingredient Coverage — Manual Clinical Verification Required',
      message: isAr
        ? `تعذر إتمام التحقق الكامل لجميع المواد الفعالة للدواء "${medicationLabel}".${missingDetail} لدى المراجع ${patientLabel} حساسية مسجلة (${documentedList}).${hasSeverePatientAllergies ? ' نظراً لوجود حساسية شديدة مسجلة، يلزم توثيق نتيجة المراجعة اليدوية قبل المتابعة.' : ' تحقق يدوياً من جميع المواد الفعالة قبل المتابعة.'}`
        : `Full active-ingredient coverage could not be verified for "${medicationLabel}".${missingDetail} Patient ${patientLabel} has documented allergies (${documentedList}).${hasSeverePatientAllergies ? ' Because this patient has a documented severe allergy, you must document your manual active-ingredient verification rationale below before proceeding.' : ' Manually verify every active ingredient before proceeding.'}`,
      acknowledgmentLabel: isAr
        ? `أؤكد التحقق اليدوي من جميع المواد الفعالة لدواء ${medication.brandName || medication.genericName} مقابل حساسيات ${patient.fullName}`
        : `I confirm I manually verified all active ingredients of ${medication.brandName || medication.genericName} against ${patient.fullName}'s documented allergies`,
    };
  }

  // Case 5: Patient has allergies with missing reaction details (incomplete allergy data)
  if (incompleteAllergies.length > 0) {
    return {
      level: 'incomplete_allergy_data',
      conflictCategory: 'incomplete_chart',
      severityTone: 'warning',
      hasSeverePatientAllergies,
      requiresPharmacistAcknowledgment: false,
      requiresDocumentedReview: false,
      requiresDocumentedOverride: false,
      patientLabel,
      medicationLabel,
      matchedAllergies: [],
      incompleteAllergies,
      verifiedIngredients: coverage.verifiedIngredients,
      unverifiedIngredients: [],
      title: isAr
        ? 'بيانات الحساسية المسجلة غير مكتملة'
        : 'Incomplete Allergy Documentation in Patient Profile',
      message: isAr
        ? `لم تظهر مطابقة مباشرة مع ${medicationLabel}، لكن سجل حساسية المراجع ${patientLabel} يفتقر لوصف التفاعل لبعض المواد (${incompleteAllergies.map((a) => a.substance).join('، ')}). راجع المراجع لتحديث تفاصيل الحساسية.`
        : `No direct match found for ${medicationLabel}, but ${patientLabel} has incomplete allergy reaction details (${incompleteAllergies.map((a) => a.substance).join(', ')}). Confirm reaction history with patient.`,
    };
  }

  // Case 6: Full authoritative active ingredient coverage + complete allergy records + no conflict found
  return {
    level: 'no_known_conflict_verified',
    conflictCategory: 'verified_clear',
    severityTone: 'neutral',
    hasSeverePatientAllergies,
    requiresPharmacistAcknowledgment: false,
    requiresDocumentedReview: false,
    requiresDocumentedOverride: false,
    patientLabel,
    medicationLabel,
    matchedAllergies: [],
    incompleteAllergies: [],
    verifiedIngredients: coverage.verifiedIngredients,
    unverifiedIngredients: [],
    title: isAr
      ? 'لا يوجد تعارض معروف مع الحساسيات الموثقة (وفق فحص كافة المكونات)'
      : 'No Known Conflict Against Verified Allergies (Full Ingredient Coverage)',
    message: isAr
      ? `تم فحص جميع المواد الفعالة الموثقة (${coverage.verifiedIngredients.join('، ')}) للدواء ${medicationLabel} مقابل الحساسيات المسجلة للمراجع ${patientLabel} ولم يُرصد تعارض معروف.`
      : `All verified active ingredients (${coverage.verifiedIngredients.join(', ')}) for ${medicationLabel} were checked against ${patientLabel}'s documented allergies with no known conflict.`,
  };
}

const VALID_OVERRIDE_AUTH_SOURCES: ReadonlyArray<AllergyOverrideAuthSource> = [
  'prescriber_written_order',
  'prescriber_verbal_verified',
  'pharmacist_clinical_escalation',
];

export function validateAllergyOverrideAuthorization(
  assessment: AllergyRiskAssessment,
  auth: AllergyOverrideAuthorization | undefined,
  lang: Language
): { valid: boolean; errors: string[] } {
  const isAr = lang === 'ar';
  const errors: string[] = [];

  if (!assessment.requiresPharmacistAcknowledgment) {
    return { valid: true, errors: [] };
  }

  if (!auth?.acknowledged) {
    errors.push(
      isAr
        ? 'يجب تأكيد إقرار مراجعة تحذير الحساسية الدوائية / المكونات قبل المتابعة.'
        : 'Pharmacist acknowledgment of the allergy / ingredient warning is required before proceeding.'
    );
  }

  const justification = auth?.clinicalJustification?.trim() ?? '';

  if (assessment.requiresDocumentedOverride) {
    const prescriber = auth?.prescriberName?.trim() ?? '';
    const source = auth?.authorizationSource;

    if (prescriber.length < 2) {
      errors.push(
        isAr
          ? 'التجاوز لتعارض حساسية حرج يتطلب توثيق اسم الطبيب الواصف أو الجهة السريرية المخوِّلة.'
          : 'Critical allergy override requires documenting the authorizing prescriber name.'
      );
    }
    if (!source || !VALID_OVERRIDE_AUTH_SOURCES.includes(source)) {
      errors.push(
        isAr
          ? 'يرجى تحديد مصدر توثيق التجاوز الطبي (أمر وصفة مكتوب / توثيق هاتفي مع الطبيب / تصعيد صيدلاني).'
          : 'Select the clinical override authorization method (written order, verified verbal order, or clinical escalation).'
      );
    }
    if (justification.length < 10) {
      errors.push(
        isAr
          ? 'التجاوز لتعارض حساسية حرج يتطلب كتابة مبرر سريري موثق (١٠ أحرف على الأقل).'
          : 'Critical allergy override requires a documented clinical justification (at least 10 characters).'
      );
    }
  } else if (assessment.requiresDocumentedReview) {
    if (justification.length < 10) {
      errors.push(
        isAr
          ? 'نظراً لوجود حساسية شديدة في ملف المراجع وعدم اكتمال اليقين الدوائي، يتطلب المتابعة كتابة خلاصة المراجعة السريرية (١٠ أحرف على الأقل).'
          : 'Because this patient has a documented severe allergy and ingredient conflict/coverage is uncertain, documented clinical review justification (at least 10 characters) is required.'
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function buildAllergyOverrideEvidencePayload(
  assessment: AllergyRiskAssessment,
  auth: AllergyOverrideAuthorization,
  staffName: string
): Record<string, unknown> {
  return {
    level: assessment.level,
    conflictCategory: assessment.conflictCategory,
    hasSeverePatientAllergies: assessment.hasSeverePatientAllergies,
    verifiedIngredients: assessment.verifiedIngredients,
    unverifiedIngredients: assessment.unverifiedIngredients,
    matchedAllergies: assessment.matchedAllergies.map((a) => ({
      substance: a.substance,
      severity: a.severity,
      reaction: a.reaction ?? null,
    })),
    acknowledged: Boolean(auth.acknowledged),
    prescriberName: auth.prescriberName?.trim() || null,
    authorizationSource: auth.authorizationSource ?? null,
    authorizationReference: auth.authorizationReference?.trim() || null,
    clinicalJustification: auth.clinicalJustification?.trim() || null,
    authorizedByStaffName: auth.authorizedByStaffName?.trim() || staffName,
    authorizedAt: auth.authorizedAt ?? new Date().toISOString(),
  };
}

// ============================================================================
// DETERMINISTIC SHA-256 DISPENSING PAYLOAD FINGERPRINT (IDEMPOTENCY INTEGRITY)
// ============================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256HexSync(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const paddedLen = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return Array.from(h)
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export interface DispensingRefillSnapshotInput {
  estimatedDailyConsumption?: number | null;
  estimatedSupplyDays?: number | null;
  estimatedSupplyEndDate?: string | null;
  totalDispensedAnalyzed?: number | null;
  estimatedRemainingUnits?: number | null;
  estimatedDaysRemaining?: number | null;
  refillStatus?: string | null;
  refillSupplyEndDate?: string | null;
  forecastAssumptions?: string | null;
  uncertaintyNote?: string | null;
  calculationSource?: string | null;
  algorithmVersion?: string | null;
}

export interface CanonicalAllergyOverrideDigestShape {
  level: string | null;
  acknowledged: boolean;
  prescriberName: string | null;
  authorizationSource: string | null;
  authorizationReference: string | null;
  clinicalJustification: string | null;
}

export function canonicalizeAllergyOverrideForHash(
  auth?: AllergyOverrideAuthorization | Record<string, unknown> | null
): CanonicalAllergyOverrideDigestShape | null {
  if (!auth || typeof auth !== 'object') return null;
  const raw = auth as Record<string, unknown>;
  const acknowledged = Boolean(raw.acknowledged);
  const level = typeof raw.level === 'string' && raw.level.trim() ? raw.level.trim() : null;
  const prescriberName =
    typeof raw.prescriberName === 'string' && raw.prescriberName.trim()
      ? raw.prescriberName.trim()
      : null;
  const authorizationSource =
    typeof raw.authorizationSource === 'string' && raw.authorizationSource.trim()
      ? raw.authorizationSource.trim()
      : null;
  const authorizationReference =
    typeof raw.authorizationReference === 'string' && raw.authorizationReference.trim()
      ? raw.authorizationReference.trim()
      : null;
  const clinicalJustification =
    typeof raw.clinicalJustification === 'string' && raw.clinicalJustification.trim()
      ? raw.clinicalJustification.trim()
      : null;

  if (
    !acknowledged &&
    !level &&
    !prescriberName &&
    !authorizationSource &&
    !authorizationReference &&
    !clinicalJustification
  ) {
    return null;
  }

  return {
    level,
    acknowledged,
    prescriberName,
    authorizationSource,
    authorizationReference,
    clinicalJustification,
  };
}

/**
 * Deterministic exact base-10 decimal formatter (4 fractional digits,
 * ROUND_HALF_AWAY_FROM_ZERO) matching PostgreSQL `round(numeric, 4)` without
 * IEEE-754 binary floating-point rounding drift (e.g., `2.00005` -> `'2.0001'`,
 * `10.50005` -> `'10.5001'`, `-2.00005` -> `'-2.0001'`).
 */
export function formatCanonicalDecimal4(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return '<NULL>';
  let raw: string;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return '<NULL>';
    raw = Object.is(val, -0) ? '0' : String(val);
  } else if (typeof val === 'string') {
    raw = val.trim();
    if (!raw) return '<NULL>';
  } else {
    return '<NULL>';
  }

  const match = raw.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return '<NULL>';

  const signNeg = match[1] === '-';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? match[4] ?? '';
  const exp = match[5] ? parseInt(match[5], 10) : 0;

  let digits = `${intPart}${fracPart}`;
  let dotPos = intPart.length + exp;

  if (dotPos <= 0) {
    digits = `${'0'.repeat(1 - dotPos)}${digits}`;
    dotPos = 1;
  }

  const keepEnd = dotPos + 4;
  if (digits.length < keepEnd + 1) {
    digits = digits.padEnd(keepEnd + 1, '0');
  }

  const kept = digits
    .slice(0, keepEnd)
    .split('')
    .map((ch) => Number(ch));
  const roundDigit = Number(digits[keepEnd]);

  if (roundDigit >= 5) {
    let carry = 1;
    for (let i = kept.length - 1; i >= 0 && carry > 0; i -= 1) {
      const next = kept[i] + carry;
      if (next >= 10) {
        kept[i] = 0;
        carry = 1;
      } else {
        kept[i] = next;
        carry = 0;
      }
    }
    if (carry > 0) {
      kept.unshift(1);
      dotPos += 1;
    }
  }

  const outInt = kept.slice(0, dotPos).join('').replace(/^0+/, '') || '0';
  const outFrac = kept.slice(dotPos, dotPos + 4).join('');
  if (outInt === '0' && outFrac === '0000') {
    return '0.0000';
  }
  return `${signNeg ? '-' : ''}${outInt}.${outFrac}`;
}

function fmtNum4(val: number | string | null | undefined): string {
  return formatCanonicalDecimal4(val);
}

function fmtIntOrNull(val: number | null | undefined): string {
  return val !== undefined && val !== null && Number.isFinite(Number(val))
    ? String(Math.trunc(Number(val)))
    : '<NULL>';
}

function fmtStrOrNull(val: string | null | undefined, lower = false): string {
  if (typeof val !== 'string') return '<NULL>';
  const trimmed = val.trim();
  if (!trimmed) return '<NULL>';
  return lower ? trimmed.toLowerCase() : trimmed;
}

export function buildCanonicalDispensingFingerprintString(params: {
  patientId: string;
  medicationPlanId: string;
  dispensedQuantity: number;
  quantityUnit: string;
  packageCount?: number | null;
  packageSize?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  dispensingDate: string;
  isPartialFill: boolean;
  notes?: string | null;
  expectedRegimenVersionNumber?: number | null;
  allergyOverrideAuthorization?: AllergyOverrideAuthorization | Record<string, unknown> | null;
  refillSnapshot?: DispensingRefillSnapshotInput | null;
}): string {
  const overrideCanon = canonicalizeAllergyOverrideForHash(params.allergyOverrideAuthorization);
  const overridePart = overrideCanon
    ? [
        fmtStrOrNull(overrideCanon.level),
        String(overrideCanon.acknowledged),
        fmtStrOrNull(overrideCanon.prescriberName),
        fmtStrOrNull(overrideCanon.authorizationSource),
        fmtStrOrNull(overrideCanon.authorizationReference),
        fmtStrOrNull(overrideCanon.clinicalJustification),
      ].join('::')
    : '<NULL>';

  const refill = params.refillSnapshot ?? null;
  const refillPart = [
    fmtNum4(refill?.estimatedDailyConsumption),
    fmtIntOrNull(refill?.estimatedSupplyDays),
    fmtStrOrNull(refill?.estimatedSupplyEndDate),
    fmtNum4(refill?.totalDispensedAnalyzed),
    fmtNum4(refill?.estimatedRemainingUnits),
    fmtIntOrNull(refill?.estimatedDaysRemaining),
    fmtStrOrNull(refill?.refillStatus),
    fmtStrOrNull(refill?.refillSupplyEndDate),
    fmtStrOrNull(refill?.forecastAssumptions),
    fmtStrOrNull(refill?.uncertaintyNote),
    fmtStrOrNull(refill?.calculationSource ?? 'provisional_client_unverified'),
    fmtStrOrNull(refill?.algorithmVersion ?? 'masar_refill_v1'),
  ].join('|');

  return [
    params.patientId.trim(),
    params.medicationPlanId.trim(),
    fmtNum4(params.dispensedQuantity),
    params.quantityUnit.trim().toLowerCase(),
    fmtIntOrNull(params.packageCount),
    fmtNum4(params.packageSize),
    fmtStrOrNull(params.batchNumber, true),
    fmtStrOrNull(params.expiryDate),
    params.dispensingDate.trim(),
    String(Boolean(params.isPartialFill)),
    fmtStrOrNull(params.notes),
    fmtIntOrNull(params.expectedRegimenVersionNumber),
    overridePart,
    refillPart,
  ].join('|');
}

export function computeDispensingPayloadHash(params: {
  patientId: string;
  medicationPlanId: string;
  dispensedQuantity: number;
  quantityUnit: string;
  packageCount?: number | null;
  packageSize?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  dispensingDate: string;
  isPartialFill: boolean;
  notes?: string | null;
  expectedRegimenVersionNumber?: number | null;
  allergyOverrideAuthorization?: AllergyOverrideAuthorization | Record<string, unknown> | null;
  refillSnapshot?: DispensingRefillSnapshotInput | null;
}): string {
  return sha256HexSync(buildCanonicalDispensingFingerprintString(params));
}

// ============================================================================
// DISPENSING VALIDATION & UNCERTAIN NETWORK OUTCOME CLASSIFICATION
// ============================================================================

export interface DispensingValidationOptions {
  patient?: Patient;
  plan?: PatientMedicationPlan;
  todayStr?: string;
  allowIncompatibleUnit?: boolean;
}

export interface DispensingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDispensingInput(
  params: RecordDispensingInput,
  lang: Language,
  options: DispensingValidationOptions = {}
): DispensingValidationResult {
  const isAr = lang === 'ar';
  const errors: string[] = [];
  const warnings: string[] = [];

  if (options.patient && options.patient.status !== 'active') {
    errors.push(
      isAr
        ? 'لا يمكن صرف علاج لمراجع ملفه مؤرشف.'
        : 'Cannot dispense medication for an archived patient.'
    );
  }

  if (options.plan) {
    if (options.plan.patientId !== params.patientId) {
      errors.push(
        isAr
          ? 'الخطة الدوائية المختارة لا تنتمي إلى هذا المراجع.'
          : 'Selected medication plan does not belong to this patient.'
      );
    }
    if (options.plan.status !== 'active') {
      errors.push(
        isAr
          ? `لا يمكن الصرف على خطة دوائية غير نشطة (الحالة الحالية: ${options.plan.status}).`
          : `Cannot dispense against a non-active medication plan (status: ${options.plan.status}).`
      );
    }
    if (
      params.expectedRegimenVersionNumber !== undefined &&
      params.expectedRegimenVersionNumber !== options.plan.currentVersionNumber
    ) {
      errors.push(
        isAr
          ? `تغيرت نسخة الخطة العلاجية إلى v${options.plan.currentVersionNumber} أثناء التحضير للصرف. يرجى تحديث الشاشة ومراجعة الجرعة الجديدة قبل الحفظ.`
          : `Regimen version changed to v${options.plan.currentVersionNumber} while preparing dispensing. Refresh and verify updated regimen before saving.`
      );
    }
  }

  if (!Number.isFinite(params.dispensedQuantity) || params.dispensedQuantity <= 0) {
    errors.push(
      isAr
        ? 'الكمية المصروفة يجب أن تكون رقماً صالحاً أكبر من صفر.'
        : 'Dispensed quantity must be a finite number greater than zero.'
    );
  } else if (params.dispensedQuantity > MAX_REASONABLE_DISPENSE_QTY) {
    errors.push(
      isAr
        ? `الكمية المصروفة (${params.dispensedQuantity}) تتجاوز الحد الأقصى المسموح (${MAX_REASONABLE_DISPENSE_QTY}).`
        : `Dispensed quantity (${params.dispensedQuantity}) exceeds safety limit (${MAX_REASONABLE_DISPENSE_QTY}).`
    );
  }

  if (!params.quantityUnit || !params.quantityUnit.trim()) {
    errors.push(isAr ? 'وحدة الصرف مطلوبة.' : 'Dispensed quantity unit is required.');
  } else if (
    options.plan &&
    !options.allowIncompatibleUnit &&
    !areUnitsCompatibleForRefill(options.plan.doseUnit, params.quantityUnit)
  ) {
    errors.push(
      isAr
        ? `وحدة الصرف (${params.quantityUnit}) غير متوافقة مع وحدة الخطة الدوائية (${options.plan.doseUnit}).`
        : `Dispensed unit (${params.quantityUnit}) is incompatible with prescribed plan unit (${options.plan.doseUnit}).`
    );
  }

  if (!isValidIsoCalendarDate(params.dispensingDate)) {
    errors.push(
      isAr ? 'تاريخ الصرف غير صالح.' : 'Dispensing date is not a valid calendar date.'
    );
  } else if (options.todayStr && isValidIsoCalendarDate(options.todayStr)) {
    if (params.dispensingDate > options.todayStr) {
      errors.push(
        isAr
          ? `تاريخ الصرف (${params.dispensingDate}) لا يمكن أن يكون في المستقبل بعد تاريخ اليوم (${options.todayStr}).`
          : `Dispensing date (${params.dispensingDate}) cannot be in the future after today (${options.todayStr}).`
      );
    }
  }

  if (params.expiryDate && params.expiryDate.trim().length > 0) {
    if (!isValidIsoCalendarDate(params.expiryDate)) {
      errors.push(
        isAr ? 'تاريخ انتهاء الصلاحية غير صالح.' : 'Batch expiry date is not a valid calendar date.'
      );
    } else if (isValidIsoCalendarDate(params.dispensingDate)) {
      if (params.expiryDate < params.dispensingDate) {
        errors.push(
          isAr
            ? `تنبيه سلامة: تاريخ انتهاء صلاحية الدواء (${params.expiryDate}) منتهٍ قبل تاريخ الصرف (${params.dispensingDate}). يُمنع صرف دواء منتهي الصلاحية.`
            : `Safety block: Medication batch expired (${params.expiryDate}) prior to dispensing date (${params.dispensingDate}). Dispensing expired stock is prohibited.`
        );
      } else {
        const daysToExpiry = diffDaysBetween(params.dispensingDate, params.expiryDate);
        if (daysToExpiry <= EXPIRY_SOON_WARNING_DAYS) {
          warnings.push(
            isAr
              ? `تنبيه قرب انتهاء الصلاحية: التشغيلة تنتهي خلال ${daysToExpiry} يوماً (${params.expiryDate}).`
              : `Near-expiry notice: batch expires in ${daysToExpiry} day(s) (${params.expiryDate}).`
          );
        }
      }
    }
  }

  const hasPackCount = params.packageCount !== undefined;
  const hasPackSize = params.packageSize !== undefined;
  if (hasPackCount && (!Number.isFinite(params.packageCount) || params.packageCount! <= 0)) {
    errors.push(
      isAr
        ? 'عدد العبوات يجب أن يكون أكبر من صفر عند إدخاله.'
        : 'Package count must be greater than zero when provided.'
    );
  }
  if (hasPackSize && (!Number.isFinite(params.packageSize) || params.packageSize! <= 0)) {
    errors.push(
      isAr
        ? 'محتوى العبوة يجب أن يكون أكبر من صفر عند إدخاله.'
        : 'Package size must be greater than zero when provided.'
    );
  }

  if (
    hasPackCount &&
    hasPackSize &&
    Number.isFinite(params.packageCount) &&
    params.packageCount! > 0 &&
    Number.isFinite(params.packageSize) &&
    params.packageSize! > 0 &&
    Number.isFinite(params.dispensedQuantity) &&
    params.dispensedQuantity > 0
  ) {
    const packTotal = Number((params.packageCount! * params.packageSize!).toFixed(4));
    if (!params.isPartialFill && Math.abs(params.dispensedQuantity - packTotal) > 1e-4) {
      errors.push(
        isAr
          ? `عدم تطابق كمية الصرف (${params.dispensedQuantity}) مع حساب العبوات (${params.packageCount} × ${params.packageSize} = ${packTotal}). فعّل خيار "صرف جزئي" أو صحح الأرقام.`
          : `Dispensed quantity (${params.dispensedQuantity}) does not match pack calculation (${params.packageCount} × ${params.packageSize} = ${packTotal}). Check "Partial fill" or correct pack counts.`
      );
    } else if (params.isPartialFill && params.dispensedQuantity > packTotal + 1e-4) {
      errors.push(
        isAr
          ? `كمية الصرف الجزئي (${params.dispensedQuantity}) لا يمكن أن تتجاوز إجمالي العبوات المحددة (${packTotal}).`
          : `Partial fill quantity (${params.dispensedQuantity}) cannot exceed total package units (${packTotal}).`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function classifyUncertainNetworkError(
  err: unknown,
  lang: Language
): { isUncertainOutcome: boolean; userMessage: string } {
  const isAr = lang === 'ar';
  const candidate = err as { code?: unknown; pgCode?: unknown; name?: unknown; message?: unknown } | null;
  const pgCode = String(candidate?.pgCode ?? candidate?.code ?? '');
  const name = String(candidate?.name ?? '');
  const message =
    err instanceof Error ? err.message : typeof candidate?.message === 'string' ? candidate.message : '';
  const lower = message.toLowerCase();

  // Deterministic rejections (never actually saved on server)
  if (
    ['42501', '23514', '23505', '23P01', '22P02', '23503', '40001'].includes(pgCode) ||
    lower.includes('clinical integrity check failed') ||
    lower.includes('permission or tenant rls policy denied') ||
    lower.includes('duplicate record constraint') ||
    lower.includes('version conflict')
  ) {
    return {
      isUncertainOutcome: false,
      userMessage: message,
    };
  }

  const looksUncertain =
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('load failed') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('connection');

  if (looksUncertain) {
    return {
      isUncertainOutcome: true,
      userMessage: isAr
        ? 'انقطع الاتصال أو انتهت مهلة الاستجابة قبل تأكيد حفظ الصرف. قد يكون السجل قد حُفظ على الخادم — حدّث سجل الصرف وتأكد قبل إعادة المحاولة لتجنب التكرار.'
        : 'Network connection was interrupted before save confirmation was received. The record may already have been saved—refresh the dispensing ledger and verify before retrying to prevent duplicate dispensing.',
    };
  }

  return {
    isUncertainOutcome: false,
    userMessage:
      message ||
      (isAr ? 'تعذر إتمام عملية الصرف.' : 'Unable to complete dispensing operation.'),
  };
}
