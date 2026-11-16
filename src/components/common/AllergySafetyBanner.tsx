import React from 'react';
import { AlertOctagon, AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { AllergyRiskAssessment } from '../../services/clinicalSafety';
import {
  AllergyOverrideAuthSource,
  AllergyOverrideAuthorization,
  BackendSafetyCapabilities,
  Language,
} from '../../types/domain';

interface AllergySafetyBannerProps {
  assessment: AllergyRiskAssessment;
  acknowledged: boolean;
  onAcknowledgeChange: (checked: boolean) => void;
  overrideAuth?: AllergyOverrideAuthorization;
  onOverrideAuthChange?: (next: AllergyOverrideAuthorization) => void;
  backendCapabilities?: BackendSafetyCapabilities;
  onRefreshCapabilities?: () => Promise<void> | void;
  lang?: Language;
  compact?: boolean;
}

export const AllergySafetyBanner: React.FC<AllergySafetyBannerProps> = ({
  assessment,
  acknowledged,
  onAcknowledgeChange,
  overrideAuth,
  onOverrideAuthChange,
  backendCapabilities,
  onRefreshCapabilities,
  lang,
  compact = false,
}) => {
  const [refreshingCaps, setRefreshingCaps] = React.useState(false);
  const showLegacyNotice =
    (assessment.requiresDocumentedOverride || assessment.requiresDocumentedReview) &&
    backendCapabilities?.stage === 'migration_0004_legacy';
  const showMalformedNotice = backendCapabilities?.probeStatus === 'malformed_response';
  const isCritical = assessment.severityTone === 'critical';
  const isWarning = assessment.severityTone === 'warning';
  const isAr = lang ? lang === 'ar' : /[\u0600-\u06FF]/.test(assessment.title);

  const containerStyle = isCritical
    ? 'bg-[#FEF2F2] border border-[#A80000] text-[#242424]'
    : isWarning
      ? 'bg-[#FFF4CE] border border-[#E0C878] text-[#242424]'
      : 'bg-[#FAF9F8] border border-[#EDEBE9] text-[#242424]';

  const titleColor = isCritical ? 'text-[#A80000]' : 'text-[#242424]';

  const IconComponent = isCritical
    ? AlertOctagon
    : isWarning
      ? AlertTriangle
      : assessment.level === 'no_known_conflict_verified'
        ? ShieldCheck
        : Info;

  const iconColor = isCritical
    ? 'text-[#A80000]'
    : isWarning
      ? 'text-[#8A6D00]'
      : 'text-[#0078D4]';

  const currentAuth: AllergyOverrideAuthorization = overrideAuth ?? {
    acknowledged,
    authorizationSource: 'prescriber_written_order',
  };

  const updateAuth = (patch: Partial<AllergyOverrideAuthorization>) => {
    const next: AllergyOverrideAuthorization = {
      ...currentAuth,
      acknowledged: patch.acknowledged !== undefined ? patch.acknowledged : acknowledged,
      ...patch,
    };
    onOverrideAuthChange?.(next);
  };

  const handleRefreshCaps = async () => {
    if (!onRefreshCapabilities || refreshingCaps) return;
    setRefreshingCaps(true);
    try {
      await onRefreshCapabilities();
    } finally {
      setRefreshingCaps(false);
    }
  };

  return (
    <div
      role={isCritical ? 'alert' : 'status'}
      className={`rounded-[6px] ${compact ? 'p-3' : 'p-3.5'} space-y-2.5 ${containerStyle}`}
    >
      <div className="flex items-start gap-2.5">
        <IconComponent className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
        <div className="space-y-1 min-w-0 flex-1">
          <div className={`text-xs font-bold leading-snug ${titleColor}`}>
            {assessment.title}
          </div>
          <div className="text-[11px] text-[#242424] leading-relaxed">
            {assessment.message}
          </div>
          <div className="text-[11px] text-[#242424]/80 flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            <span>{assessment.patientLabel}</span>
            <span>·</span>
            <span className="font-semibold">{assessment.medicationLabel}</span>
          </div>
        </div>
      </div>

      {assessment.requiresPharmacistAcknowledgment && assessment.acknowledgmentLabel && (
        <label
          className={`flex items-start gap-2 pt-2 border-t text-xs font-semibold cursor-pointer ${
            isCritical
              ? 'border-[#A80000]/25 text-[#A80000]'
              : 'border-[#E0C878] text-[#242424]'
          }`}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => {
              const checked = e.target.checked;
              onAcknowledgeChange(checked);
              updateAuth({ acknowledged: checked });
            }}
            className="w-4 h-4 mt-0.5 accent-[#0078D4] rounded-[4px] shrink-0"
          />
          <span className="leading-snug">{assessment.acknowledgmentLabel}</span>
        </label>
      )}

      {assessment.requiresDocumentedOverride && onOverrideAuthChange && (
        <div className="pt-2.5 border-t border-[#A80000]/25 bg-white rounded-[6px] border border-[#EDEBE9] p-3 space-y-2.5">
          <div className="text-[11px] font-bold text-[#A80000]">
            {isAr
              ? 'توثيق تجاوز الحساسية الحرج (إلزامي قبل الحفظ أو الصرف)'
              : 'Critical Allergy Override Documentation (Required Before Saving or Dispensing)'}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold text-[#242424] mb-1">
                {isAr ? 'الطبيب / الجهة السريرية المخوِّلة *' : 'Authorizing Prescriber / Clinician *'}
              </label>
              <input
                type="text"
                value={currentAuth.prescriberName ?? ''}
                onChange={(e) => updateAuth({ prescriberName: e.target.value })}
                placeholder={isAr ? 'د. طارق النعيمي' : 'Dr. Tariq Al-Nuaimi'}
                className="w-full px-2.5 py-1.5 text-xs text-[#242424] bg-white border border-[#EDEBE9] rounded-[4px] focus:border-[#0078D4] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#242424] mb-1">
                {isAr ? 'مصدر الموافقة السريرية *' : 'Authorization Source *'}
              </label>
              <select
                value={currentAuth.authorizationSource ?? 'prescriber_written_order'}
                onChange={(e) =>
                  updateAuth({ authorizationSource: e.target.value as AllergyOverrideAuthSource })
                }
                className="w-full px-2.5 py-1.5 text-xs text-[#242424] bg-white border border-[#EDEBE9] rounded-[4px] focus:border-[#0078D4] focus:outline-none"
              >
                <option value="prescriber_written_order">
                  {isAr ? 'أمر وصفة مكتوب من الطبيب' : 'Prescriber Written Order'}
                </option>
                <option value="prescriber_verbal_verified">
                  {isAr ? 'تأكيد هاتفي موثق مع الطبيب' : 'Verified Prescriber Verbal Order'}
                </option>
                <option value="pharmacist_clinical_escalation">
                  {isAr ? 'تصعيد ومراجعة صيدلانية سريرية' : 'Pharmacist Clinical Escalation'}
                </option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#242424] mb-1">
              {isAr ? 'رقم الوصفة / مرجع الاستشارة (اختياري)' : 'Order / Consult Reference (optional)'}
            </label>
            <input
              type="text"
              value={currentAuth.authorizationReference ?? ''}
              onChange={(e) => updateAuth({ authorizationReference: e.target.value })}
              placeholder={isAr ? 'مثال: RX-2026-419' : 'e.g. RX-2026-419'}
              className="w-full px-2.5 py-1.5 text-xs text-[#242424] bg-white border border-[#EDEBE9] rounded-[4px] focus:border-[#0078D4] focus:outline-none font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#242424] mb-1">
              {isAr
                ? 'المبرر السريري الموثق (١٠ أحرف على الأقل) *'
                : 'Documented Clinical Justification (min 10 chars) *'}
            </label>
            <textarea
              rows={2}
              value={currentAuth.clinicalJustification ?? ''}
              onChange={(e) => updateAuth({ clinicalJustification: e.target.value })}
              placeholder={
                isAr
                  ? 'اذكر التحقق من عدم وجود بديل أو خطة المتابعة السريرية المعتمدة...'
                  : 'Document clinical rationale, prescriber confirmation, and monitoring plan...'
              }
              className="w-full px-2.5 py-1.5 text-xs text-[#242424] bg-white border border-[#EDEBE9] rounded-[4px] focus:border-[#0078D4] focus:outline-none"
            />
          </div>
        </div>
      )}

      {!assessment.requiresDocumentedOverride &&
        assessment.requiresDocumentedReview &&
        onOverrideAuthChange && (
          <div className="pt-2.5 border-t border-[#E0C878] bg-white rounded-[6px] border border-[#EDEBE9] p-3 space-y-2">
            <div className="text-[11px] font-bold text-[#242424]">
              {isAr
                ? 'توثيق المراجعة السريرية لعدم اليقين الدوائي (حساسية شديدة مسجلة للمراجع) *'
                : 'Documented Clinical Review Rationale (Required — Patient Has Severe Allergy) *'}
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#242424] mb-1">
                {isAr
                  ? 'خلاصة التحقق من المواد الفعالة أو التفاعل المتصالب (١٠ أحرف على الأقل) *'
                  : 'Active Ingredient / Cross-Reactivity Verification Note (min 10 chars) *'}
              </label>
              <textarea
                rows={2}
                value={currentAuth.clinicalJustification ?? ''}
                onChange={(e) => updateAuth({ clinicalJustification: e.target.value })}
                placeholder={
                  isAr
                    ? 'مثال: تم فحص نشرة الدواء كاملة والتأكد من خلو التركيبة من المسبب للحساسية...'
                    : 'e.g. Verified package insert active ingredients and confirmed no cross-reactive allergen...'
                }
                className="w-full px-2.5 py-1.5 text-xs text-[#242424] bg-white border border-[#EDEBE9] rounded-[4px] focus:border-[#0078D4] focus:outline-none"
              />
            </div>
          </div>
        )}

      {(showLegacyNotice || showMalformedNotice) && (
        <div
          role="status"
          className="p-2.5 bg-[#FFF4CE] border border-[#E0C878] rounded-[6px] text-[11px] text-[#242424] flex items-start justify-between gap-2"
        >
          <div className="flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-[#8A6D00] shrink-0 mt-0.5" />
            <span>
              {showMalformedNotice
                ? isAr
                  ? 'تعذر التحقق من قدرات الأمان الخادمية (استجابة غير صالحة). يعمل النظام بوضع الحماية التحفظي.'
                  : 'Server capability probe returned an invalid payload; running in conservative legacy fallback.'
                : isAr
                  ? 'ملاحظة التوافق (الترحيل 0004): التحقق من الحساسية مفعّل على الواجهة حالياً؛ أما الفرض الخادمي وحفظ بيانات التفويض في audit_logs فيتفعلان بعد ترقية الخادم إلى Stage 2C.2C (_v2).'
                  : 'Migration 0004 compatibility notice: Allergy review validation is enforced client-side; server-side enforcement and audit_logs persistence activate once Stage 2C.2C (_v2) SQL is deployed.'}
            </span>
          </div>
          {onRefreshCapabilities && (
            <button
              type="button"
              disabled={refreshingCaps}
              onClick={handleRefreshCaps}
              className="px-2.5 py-1 text-[11px] font-semibold text-white bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 rounded-[4px] shrink-0"
            >
              {isAr ? 'تحديث القدرات' : 'Refresh'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
