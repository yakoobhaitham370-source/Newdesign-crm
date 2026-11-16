import React from 'react';
import { Database, Lock, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { useCrm } from '../context/CrmContext';
import { formatDateTime, LABELS } from '../i18n/translations';
import { getAuditLogDisplaySummary } from '../services/auditDisplayHelper';
import { SUPABASE_STAGE2_SCHEMA_SPEC } from '../types/supabaseSchemaSpec';

export const GovernanceView: React.FC = () => {
  const { lang, state, isConnectedMode } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  return (
    <div className="space-y-6">
      {/* Architecture Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
        <div className="flex items-center gap-2 text-[#103354]">
          <ShieldCheck className="w-5 h-5 text-[#008C87]" />
          <h2 className="text-lg font-bold">
            {isConnectedMode
              ? isAr
                ? 'حوكمة الصيدلية، الصلاحيات، وسجل التدقيق (الوضع المتصل)'
                : 'Pharmacy Governance, RBAC Roles & Audit Log (Connected Mode)'
              : isAr
                ? 'البنية المقترحة، الصلاحيات، وسجل التدقيق (المرحلة ٢)'
                : 'Proposed Architecture, RBAC Roles & Audit Log (Stage 2 Blueprint)'}
          </h2>
        </div>
        <p className="text-xs text-slate-600">
          {isConnectedMode
            ? isAr
              ? 'يعمل النظام حالياً بالوضع المتصل مع قاعدة بيانات Supabase PostgreSQL وسياسات RLS المفروضة على مستوى الصيدلية.'
              : 'Connected Mode is active against Supabase PostgreSQL with forced pharmacy-level Row-Level Security (RLS) policies.'
            : isAr
              ? 'لا توجد قاعدة بيانات حقيقية متصلة في المرحلة ١. يعرض هذا القسم نموذج الصلاحيات المخطط، جداول Supabase PostgreSQL، وعقد التكامل مع تطبيق الأندرويد.'
              : 'No live database is connected in Stage 1. This view documents the planned Supabase RBAC model, PostgreSQL schema, and Android API contract.'}
        </p>
      </div>

      {/* Role Matrix */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <Users className="w-4 h-4 text-[#008C87]" />
          <h3 className="text-base font-bold text-[#103354]">
            {isAr ? 'مصفوفة الأدوار والصلاحيات' : 'Role & Access Control Matrix'}
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="bg-[#F5F7FA] border-b border-slate-200 text-slate-600">
              <tr>
                <th className="py-3 px-4 text-start">{isAr ? 'الدور' : 'Role'}</th>
                <th className="py-3 px-4 text-start">{isAr ? 'نطاق الوصول' : 'Data Scope'}</th>
                <th className="py-3 px-4 text-start">{isAr ? 'تسجيل المرضى' : 'Patient Onboarding'}</th>
                <th className="py-3 px-4 text-start">{isAr ? 'إدارة الكادر' : 'Staff Management'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr>
                <td className="py-3 px-4 font-bold text-[#103354]">{t.roles.platform_owner}</td>
                <td className="py-3 px-4">{isAr ? 'إدارة الصيدليات المشتركة (بدون كشف بيانات سريرية غير مخولة)' : 'Platform governance'}</td>
                <td className="py-3 px-4">{isAr ? 'عبر تفويض الصيدلية' : 'Delegated to pharmacy'}</td>
                <td className="py-3 px-4">{isAr ? 'تفعيل مالكي الصيدليات' : 'Provision owners'}</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-bold text-[#103354]">{t.roles.pharmacy_owner}</td>
                <td className="py-3 px-4">{isAr ? 'جميع سجلات صيدليته المعزولة عبر RLS' : 'Own pharmacy only (RLS)'}</td>
                <td className="py-3 px-4">{isAr ? 'كامل الصلاحية + إصدار QR' : 'Full + Issue QR'}</td>
                <td className="py-3 px-4">{isAr ? 'إضافة/تعطيل صيادلة الصيدلية' : 'Manage pharmacy staff'}</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-bold text-[#103354]">{t.roles.authorized_pharmacist}</td>
                <td className="py-3 px-4">{isAr ? 'سجلات صيدليته فقط' : 'Assigned pharmacy only'}</td>
                <td className="py-3 px-4">{isAr ? 'تسجيل مريض + إصدار QR' : 'Register + Issue QR'}</td>
                <td className="py-3 px-4">{isAr ? 'غير مخوّل' : 'Not permitted'}</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-bold text-[#008C87]">{t.roles.patient_apk_user}</td>
                <td className="py-3 px-4">{isAr ? 'ملفه الشخصي وجرعاته المسموحة فقط' : 'Own permitted records only'}</td>
                <td className="py-3 px-4">{isAr ? 'لا يوجد تسجيل ذاتي (تفعيل بالدعوة فقط)' : 'No self-registration'}</td>
                <td className="py-3 px-4">{isAr ? 'غير مخوّل' : 'Not permitted'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Proposed Schema & Android Contract */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-[#008C87]" />
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'نموذج قاعدة البيانات المقترح (Supabase PostgreSQL)' : 'Proposed Supabase Database Tables'}
            </h3>
          </div>
          <p className="text-xs text-slate-600">
            {isAr
              ? 'جميع الجداول السريرية محمية بعزل pharmacy_id وسياسات Row-Level Security (RLS).'
              : 'All clinical tables enforce strict pharmacy_id tenant isolation via Row-Level Security (RLS).'}
          </p>
          <div className="space-y-2 pt-1 max-h-80 overflow-y-auto pe-1">
            {SUPABASE_STAGE2_SCHEMA_SPEC.map((tbl) => (
              <div
                key={tbl.tableName}
                className="p-2.5 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs space-y-1"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-bold text-[#103354]">{tbl.tableName}</span>
                  <span className="font-mono text-[11px] text-slate-500">{tbl.primaryKey}</span>
                </div>
                {tbl.uniqueConstraints.length > 0 && (
                  <div className="text-[11px] text-[#008C87] font-mono">
                    UNIQUE: {tbl.uniqueConstraints.join(', ')}
                  </div>
                )}
                <div className="text-[11px] text-slate-600">{tbl.rlsPolicySummary}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-[#008C87]" />
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'عقد التكامل المستقبلي مع Android APK' : 'Future Android APK API Contract'}
            </h3>
          </div>
          <ul className="text-xs text-slate-700 space-y-2">
            <li className="flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 text-[#103354] shrink-0 mt-0.5" />
              <span>
                <strong className="font-mono">POST /rpc/redeem_patient_invitation</strong> —{' '}
                {isAr
                  ? 'التحقق من الرمز أحادي الاستخدام + هوية المراجع (تاريخ الميلاد + OTP) قبل ربط الجهاز.'
                  : 'Server-side single-use token verification + patient identity check.'}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 text-[#103354] shrink-0 mt-0.5" />
              <span>
                <strong className="font-mono">GET /api/v1/patient/sync-plans</strong> —{' '}
                {isAr
                  ? 'مزامنة الخطط الدوائية النشطة وجداول الجرعات بتوقيت Asia/Baghdad.'
                  : 'Fetch active medication plans and DoseSchedule specs in Asia/Baghdad.'}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 text-[#103354] shrink-0 mt-0.5" />
              <span>
                <strong className="font-mono">POST /api/v1/patient/dose-confirmations</strong> —{' '}
                {isAr
                  ? 'رفع تأكيدات الجرعات مع مفتاح منع التكرار (clientEventUuid) للمزامنة دون اتصال.'
                  : 'Idempotent dose confirmation upload with clientEventUuid for offline sync.'}
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Live Audit Log */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-bold text-[#103354]">
            {isConnectedMode
              ? isAr
                ? 'سجل التدقيق الموثق (Audit Log)'
                : 'Authoritative Pharmacy Audit Log'
              : isAr
                ? 'سجل التدقيق الحي (Audit Log)'
                : 'Live Stage 1 Audit Log'}
          </h3>
          <span className="text-xs text-slate-500 tabular-nums">
            {state.auditLogs.length} {isAr ? 'سجل' : 'entries'}
          </span>
        </div>
        <div className="divide-y divide-slate-100">
          {state.auditLogs.map((log) => {
            const display = getAuditLogDisplaySummary(log, lang);
            return (
              <div
                key={log.id}
                className="px-5 py-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="space-y-0.5">
                  <div>
                    <span className="font-mono font-semibold text-[#008C87] me-2">
                      {log.action}
                    </span>
                    <span className="text-slate-800">{display.primaryText}</span>
                  </div>
                  {display.supportingDetail && (
                    <div dir="ltr" className="text-[11px] text-slate-500">
                      {display.supportingDetail}
                    </div>
                  )}
                </div>
                <div className="text-slate-500 tabular-nums shrink-0">
                  {log.actorName} · {formatDateTime(log.timestamp, lang)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
