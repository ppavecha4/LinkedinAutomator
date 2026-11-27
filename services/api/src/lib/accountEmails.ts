/**
 * The account emails (verify, reset, invitation) in the languages of the app's screens. The language is
 * the one on screen when the person asked: the dashboard sends it as Accept-Language. Anything else,
 * and background emails, are in English.
 */

import type { Request } from 'express';

export const EMAIL_LANGUAGES = ['en', 'es', 'pt', 'de', 'nl', 'ar'] as const;
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number];

export function requestLanguage(req: Request): EmailLanguage {
  const asked = (req.headers['accept-language'] ?? '').toString().split(',')[0].trim().toLowerCase().split(/[-_;]/)[0];
  return EMAIL_LANGUAGES.find((l) => l === asked) ?? 'en';
}

interface Words {
  hi: (name: string | null) => string;
  verify: { subject: string; body: (link: string) => string };
  reset: { subject: string; body: (link: string, minutes: number) => string };
  adminReset: { body: (link: string, minutes: number) => string };
  invite: { subject: (org: string | null) => string; body: (org: string | null, role: string, link: string, days: number) => string };
}

const role = (names: Record<string, string>, code: string): string => names[code] ?? code;

const WORDS: Record<EmailLanguage, Words> = {
  en: {
    hi: (name) => `Hi ${name ?? 'there'},`,
    verify: {
      subject: 'Verify your email address',
      body: (link) => `Confirm your email address to start launching campaigns:\n\n${link}\n\nThis link works once, for 3 days. If you didn't create an account, ignore this email.\n`,
    },
    reset: {
      subject: 'Reset your password',
      body: (link, minutes) => `Someone asked to reset the password for this address. Choose a new one here:\n\n${link}\n\nThe link works once, for ${minutes} minutes. If it wasn't you, ignore this email: your password stays as it is.\n`,
    },
    adminReset: { body: (link, minutes) => `Your administrator started a password reset for you. Choose a new password here:\n\n${link}\n\nThe link works once, for ${minutes} minutes.\n` },
    invite: {
      subject: (org) => `You're invited to ${org ?? 'a team'} on AmiReach`,
      body: (org, r, link, days) => `You've been invited to join ${org ?? 'a team'} as ${r}.\n\nAccept here:\n\n${link}\n\nThe link works once, for ${days} days.\n`,
    },
  },
  es: {
    hi: (name) => (name ? `Hola ${name}:` : 'Hola:'),
    verify: {
      subject: 'Confirma tu dirección de correo',
      body: (link) => `Confirma tu dirección de correo para poder lanzar campañas:\n\n${link}\n\nEl enlace funciona una sola vez, durante 3 días. Si no has creado una cuenta, ignora este correo.\n`,
    },
    reset: {
      subject: 'Restablece tu contraseña',
      body: (link, minutes) => `Alguien ha pedido restablecer la contraseña de esta dirección. Elige una nueva aquí:\n\n${link}\n\nEl enlace funciona una sola vez, durante ${minutes} minutos. Si no has sido tú, ignora este correo: tu contraseña no cambia.\n`,
    },
    adminReset: { body: (link, minutes) => `Tu administrador ha iniciado el cambio de tu contraseña. Elige una nueva aquí:\n\n${link}\n\nEl enlace funciona una sola vez, durante ${minutes} minutos.\n` },
    invite: {
      subject: (org) => `Te invitan a ${org ?? 'un equipo'} en AmiReach`,
      body: (org, r, link, days) => `Te han invitado a unirte a ${org ?? 'un equipo'} como ${role({ admin: 'administrador', member: 'miembro', viewer: 'lector', owner: 'propietario' }, r)}.\n\nAcepta aquí:\n\n${link}\n\nEl enlace funciona una sola vez, durante ${days} días.\n`,
    },
  },
  pt: {
    hi: (name) => (name ? `Olá ${name},` : 'Olá,'),
    verify: {
      subject: 'Confirme o seu endereço de e-mail',
      body: (link) => `Confirme o seu endereço de e-mail para começar a lançar campanhas:\n\n${link}\n\nA ligação funciona uma única vez, durante 3 dias. Se não criou uma conta, ignore este e-mail.\n`,
    },
    reset: {
      subject: 'Redefina a sua palavra-passe',
      body: (link, minutes) => `Alguém pediu para redefinir a palavra-passe deste endereço. Escolha uma nova aqui:\n\n${link}\n\nA ligação funciona uma única vez, durante ${minutes} minutos. Se não foi você, ignore este e-mail: a sua palavra-passe mantém-se.\n`,
    },
    adminReset: { body: (link, minutes) => `O seu administrador iniciou a redefinição da sua palavra-passe. Escolha uma nova aqui:\n\n${link}\n\nA ligação funciona uma única vez, durante ${minutes} minutos.\n` },
    invite: {
      subject: (org) => `Convite para ${org ?? 'uma equipa'} no AmiReach`,
      body: (org, r, link, days) => `Foi convidado a juntar-se a ${org ?? 'uma equipa'} como ${role({ admin: 'administrador', member: 'membro', viewer: 'leitor', owner: 'proprietário' }, r)}.\n\nAceite aqui:\n\n${link}\n\nA ligação funciona uma única vez, durante ${days} dias.\n`,
    },
  },
  de: {
    hi: (name) => (name ? `Guten Tag ${name},` : 'Guten Tag,'),
    verify: {
      subject: 'Bestätigen Sie Ihre E-Mail-Adresse',
      body: (link) => `Bestätigen Sie Ihre E-Mail-Adresse, um Kampagnen starten zu können:\n\n${link}\n\nDer Link funktioniert einmal und 3 Tage lang. Wenn Sie kein Konto angelegt haben, ignorieren Sie diese E-Mail.\n`,
    },
    reset: {
      subject: 'Passwort zurücksetzen',
      body: (link, minutes) => `Für diese Adresse wurde das Zurücksetzen des Passworts angefordert. Wählen Sie hier ein neues:\n\n${link}\n\nDer Link funktioniert einmal und ${minutes} Minuten lang. Wenn Sie das nicht waren, ignorieren Sie diese E-Mail: Ihr Passwort bleibt unverändert.\n`,
    },
    adminReset: { body: (link, minutes) => `Ihr Administrator hat das Zurücksetzen Ihres Passworts gestartet. Wählen Sie hier ein neues:\n\n${link}\n\nDer Link funktioniert einmal und ${minutes} Minuten lang.\n` },
    invite: {
      subject: (org) => `Einladung zu ${org ?? 'einem Team'} auf AmiReach`,
      body: (org, r, link, days) => `Sie wurden eingeladen, ${org ?? 'einem Team'} beizutreten. Ihre Rolle: ${role({ admin: 'Administrator', member: 'Mitglied', viewer: 'Betrachter', owner: 'Inhaber' }, r)}.\n\nHier annehmen:\n\n${link}\n\nDer Link funktioniert einmal und ${days} Tage lang.\n`,
    },
  },
  nl: {
    hi: (name) => (name ? `Hallo ${name},` : 'Hallo,'),
    verify: {
      subject: 'Bevestig je e-mailadres',
      body: (link) => `Bevestig je e-mailadres om campagnes te kunnen starten:\n\n${link}\n\nDe link werkt één keer, gedurende 3 dagen. Heb je geen account aangemaakt? Negeer dan deze e-mail.\n`,
    },
    reset: {
      subject: 'Stel je wachtwoord opnieuw in',
      body: (link, minutes) => `Iemand heeft gevraagd het wachtwoord van dit adres opnieuw in te stellen. Kies hier een nieuw wachtwoord:\n\n${link}\n\nDe link werkt één keer, gedurende ${minutes} minuten. Was jij dit niet? Negeer dan deze e-mail: je wachtwoord blijft hetzelfde.\n`,
    },
    adminReset: { body: (link, minutes) => `Je beheerder heeft het opnieuw instellen van je wachtwoord gestart. Kies hier een nieuw wachtwoord:\n\n${link}\n\nDe link werkt één keer, gedurende ${minutes} minuten.\n` },
    invite: {
      subject: (org) => `Je bent uitgenodigd voor ${org ?? 'een team'} op AmiReach`,
      body: (org, r, link, days) => `Je bent uitgenodigd voor ${org ?? 'een team'}. Je rol: ${role({ admin: 'beheerder', member: 'lid', viewer: 'kijker', owner: 'eigenaar' }, r)}.\n\nAccepteer hier:\n\n${link}\n\nDe link werkt één keer, gedurende ${days} dagen.\n`,
    },
  },
  ar: {
    hi: (name) => (name ? `مرحباً ${name}،` : 'مرحباً،'),
    verify: {
      subject: 'أكّد عنوان بريدك الإلكتروني',
      body: (link) => `أكّد عنوان بريدك الإلكتروني لتتمكن من إطلاق الحملات:\n\n${link}\n\nيعمل الرابط مرة واحدة ولمدة 3 أيام. إذا لم تنشئ حساباً فتجاهل هذه الرسالة.\n`,
    },
    reset: {
      subject: 'إعادة تعيين كلمة المرور',
      body: (link, minutes) => `طلب أحدهم إعادة تعيين كلمة المرور لهذا العنوان. اختر كلمة مرور جديدة هنا:\n\n${link}\n\nيعمل الرابط مرة واحدة، ومدة صلاحيته بالدقائق: ${minutes}. إذا لم تكن أنت من طلب ذلك فتجاهل هذه الرسالة: ستبقى كلمة مرورك كما هي.\n`,
    },
    adminReset: { body: (link, minutes) => `بدأ مسؤول حسابك إعادة تعيين كلمة مرورك. اختر كلمة مرور جديدة هنا:\n\n${link}\n\nيعمل الرابط مرة واحدة، ومدة صلاحيته بالدقائق: ${minutes}.\n` },
    invite: {
      subject: (org) => `دعوة للانضمام إلى ${org ?? 'فريق'} على AmiReach`,
      body: (org, r, link, days) => `دُعيت للانضمام إلى ${org ?? 'فريق'} بدور: ${role({ admin: 'مسؤول', member: 'عضو', viewer: 'مُطّلِع', owner: 'مالك' }, r)}.\n\nاقبل الدعوة هنا:\n\n${link}\n\nيعمل الرابط مرة واحدة، ومدة صلاحيته بالأيام: ${days}.\n`,
    },
  },
};

export const emailWords = (language: EmailLanguage): Words => WORDS[language];
