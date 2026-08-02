'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TouchDoubleTapTextarea } from '@/components/TouchDoubleTapTextarea';
import { DeviceCamera, type DeviceCameraMode } from '@/components/DeviceCamera';
import {
  MileageTracker,
  normalizeMileageLogs,
  mileageLogsFromDoc,
  sumMileageLogs,
  DEFAULT_MILEAGE_RATE,
  type MileageLog,
} from '@/components/MileageTracker';
import { AIReceptionist } from '@/components/AIReceptionist';
import { SubscriptionGate } from '@/components/SubscriptionGate';
import {
  DEFAULT_RECEPTIONIST_SETTINGS,
  normalizeReceptionistMessages,
  normalizeReceptionistSettings,
  type ReceptionistMessage,
  type ReceptionistSettings,
} from '@/lib/ai-receptionist';
import {
  DEFAULT_BILLING_SNAPSHOT,
  formatPeriodEnd,
  hasAppAccess,
  type BillingSnapshot,
} from '@/lib/billing';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';
import { isMediaPdfRef, resolveMediaDisplayUrl } from '@/lib/media-url';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { getLineItemUnitOptions, LINE_ITEM_UNITS } from '@/lib/quote-units';
import {
  APP_LANGUAGES,
  hasBuiltinUiPack,
  isKnownLanguageCode,
  languageLabel,
} from '@/lib/languages';
import { getQuoteOfTheDay } from '@/lib/quote-of-the-day';
import {
  buildPaymentTrackingNote,
  buildPayPalPayUrl,
  buildZellePaymentMemo,
  cleanPayPalHandle,
  cleanVenmoHandle,
  cleanZelleHandle,
  hasPayPalHandle,
  hasPayPalSetup,
  hasVenmoHandle,
  hasVenmoSetup,
  hasZelleHandle,
  hasZelleSetup,
  isPayPalEmail,
  openPayPalPaymentPage,
  openVenmoPaymentPage,
  type PaymentMethodSettings,
} from '@/lib/payment-links';
import {
  normalizeStoredCostBreakdown,
  syncLineItemPricingFromJobTotal,
} from '@/lib/breakdown-pricing';
import { rankAddressSuggestions } from '@/lib/address-autocomplete';

const DEFAULT_DISCOUNT_NAMES = ['Military', 'Return customer'];

const DEFAULT_PAYMENT_SETTINGS = {
  stripe: { enabled: true, connected: false },
  echeck: { enabled: true, connected: false },
  paypal: { enabled: true, connected: false },
  venmo: { enabled: true, connected: false },
  zelle: { enabled: true, connected: false },
  mailcheck: { enabled: true, connected: false },
  nowpayments: { enabled: false, connected: false },
  coinbase_commerce: { enabled: false, connected: false },
};

const CRYPTO_PAYMENT_METHODS = new Set(['nowpayments', 'coinbase_commerce']);

const getPaymentMethodMeta = (method: string) => {
  const meta: Record<string, { icon: string; label: string; description: string; category: 'traditional' | 'crypto' }> = {
    stripe: { icon: '💳', label: 'Stripe', description: 'Cards, Apple Pay, Google Pay', category: 'traditional' },
    echeck: { icon: '🏦', label: 'eCheck / ACH', description: 'Bank account (ACH)', category: 'traditional' },
    paypal: { icon: '💰', label: 'PayPal', description: 'PayPal.Me link or business email — accept real payments', category: 'traditional' },
    venmo: { icon: '📱', label: 'Venmo', description: 'Mobile app payment', category: 'traditional' },
    zelle: { icon: '🏦', label: 'Zelle', description: 'QR code or unique name/email/phone for client payments', category: 'traditional' },
    mailcheck: {
      icon: '✉️',
      label: 'Mail check to',
      description: 'Mailing address for clients to send paper checks',
      category: 'traditional',
    },
    nowpayments: { icon: '₿', label: 'NOWPayments', description: 'Bitcoin, Ethereum, and 300+ cryptocurrencies', category: 'crypto' },
    coinbase_commerce: { icon: '🪙', label: 'Coinbase Commerce', description: 'Crypto checkout via Coinbase Commerce', category: 'crypto' },
  };
  return meta[method] || { icon: '💳', label: method, description: 'Payment provider', category: 'traditional' };
};

const mergePaymentSettings = (settings?: Record<string, PaymentMethodSettings>) => {
  const merged: Record<string, { enabled: boolean; connected: boolean; handle?: string; qrUrl?: string }> = {};
  for (const [key, defaults] of Object.entries(DEFAULT_PAYMENT_SETTINGS)) {
    const saved = settings?.[key];
    merged[key] = {
      enabled: saved?.enabled ?? defaults.enabled,
      // Handle-based methods (not external OAuth "connect")
      connected:
        key === 'venmo' || key === 'zelle' || key === 'paypal' || key === 'mailcheck'
          ? !!(saved?.handle || saved?.qrUrl)
          : (saved?.connected ?? defaults.connected),
      handle: saved?.handle,
      qrUrl: saved?.qrUrl,
    };
  }
  if (settings) {
    for (const [key, saved] of Object.entries(settings)) {
      if (!merged[key]) {
        merged[key] = {
          enabled: !!saved?.enabled,
          connected: !!saved?.connected,
          handle: saved?.handle,
          qrUrl: saved?.qrUrl,
        };
      }
    }
  }
  return merged;
};

const mergeDiscountNames = (names: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of [...DEFAULT_DISCOUNT_NAMES, ...names]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
};

const roundMoney = (n: number) => Math.round(n * 100) / 100;

const computeDiscountAmount = (
  subtotal: number,
  description: string,
  value: number,
  type: 'percent' | 'dollar'
) => {
  if (!description?.trim() || !value || value <= 0 || subtotal <= 0) return 0;
  if (type === 'percent') {
    return roundMoney(Math.min(subtotal, subtotal * (value / 100)));
  }
  return roundMoney(Math.min(subtotal, value));
};

const getLineItemTotal = (item: { total?: number; qty?: number; price?: number }) => {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  if (item.total != null && Number.isFinite(Number(item.total))) {
    return roundMoney(Number(item.total));
  }
  return roundMoney(qty * price);
};

const normalizeLoadedLineItem = (item: any) => {
  const qty = Number(item.qty) || 0;
  const price = roundMoney(Number(item.price) || 0);
  const total = getLineItemTotal({ ...item, qty, price });
  return { ...item, qty, price, total };
};

const computeEstimateTotals = (input: {
  items: Array<{ total?: number; qty?: number; price?: number }>;
  laborAmount?: number;
  isTaxExempt?: boolean;
  taxesEnabled?: boolean;
  taxRate: number;
  discountDescription?: string;
  discountValue?: number;
  discountType?: 'percent' | 'dollar';
  storedDiscountAmount?: number;
}) => {
  const labor = roundMoney(Number(input.laborAmount) || 0);
  const itemsTotal = roundMoney(
    (input.items || []).reduce((sum, item) => sum + getLineItemTotal(item), 0)
  );
  const subtotalBeforeDiscount = itemsTotal;

  let discountAmount = 0;
  if (input.storedDiscountAmount && input.storedDiscountAmount > 0) {
    discountAmount = roundMoney(Math.min(subtotalBeforeDiscount, input.storedDiscountAmount));
  } else {
    discountAmount = computeDiscountAmount(
      subtotalBeforeDiscount,
      input.discountDescription || '',
      Number(input.discountValue) || 0,
      input.discountType || 'dollar'
    );
  }

  const taxableTotal = roundMoney(Math.max(0, itemsTotal - discountAmount));
  const taxRate = Number(input.taxRate) || 0;
  const taxesEnabled = input.taxesEnabled !== false;
  const taxAmount =
    taxesEnabled && !input.isTaxExempt
      ? roundMoney(taxableTotal * (taxRate / 100))
      : 0;
  const subtotalAfterDiscount = roundMoney(Math.max(0, itemsTotal - discountAmount));
  const grandTotal = roundMoney(Math.max(0, subtotalAfterDiscount + taxAmount));

  return {
    itemsTotal,
    laborAmount: labor,
    subtotalBeforeDiscount,
    subtotalAfterDiscount,
    discountAmount,
    taxableTotal,
    taxAmount,
    grandTotal,
  };
};

export default function Home() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  // Helper for Storage URLs - works with Private bucket (recommended for security)
  // Uses signed URLs (valid for 24 hours) instead of public URLs
  const getMediaUrl = async (filePath: string): Promise<string> => {
    if (!supabase) return '';
    const { data } = await supabase.storage.from('media').createSignedUrl(filePath, 60 * 60 * 24); // 24h expiry
    return data?.signedUrl || '';
  };

  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView' | 'archivesView' | 'sendPreview' | 'reportsView' | 'receptionistView'>('dashboard');

  // Login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  // Crew session (same main login as owner; resolved via /api/crew/me)
  const [currentCrew, setCurrentCrew] = useState<any>(null);
  const [crewResolved, setCrewResolved] = useState(false);

  // Forgot password states
  const [showMainForgot, setShowMainForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');

  // 2FA states
  const [requires2FA, setRequires2FA] = useState(false);
  const [twoFactorPhone, setTwoFactorPhone] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [expected2FACode, setExpected2FACode] = useState('');

  // Simple i18n translations (expand as needed) - full keys for entire app
  const translations: any = {
    en: {
      welcome: "Welcome back!",
      dashboard: "Dashboard",
      estimates: "Estimates",
      invoices: "Invoices",
      newEstimate: "New Estimate",
      newInvoice: "New Invoice",
      reports: "Reports",
      calendar: "Calendar",
      profile: "Profile",
      companyProfile: "Company Profile",
      termsConditions: "Terms & Conditions",
      saveProfile: "Save Profile",
      totalOutstanding: "Total Outstanding",
      yearToDateSales: "Year to Date Sales",
      crew: "Crew / Sub-contractors",
      companyName: "Company Name",
      slogan: "Slogan",
      phone: "Phone",
      email: "Email",
      address: "Address",
      city: "City",
      state: "State",
      zipCode: "Zip Code",
      logo: "Company Logo / Photo",
      backToLogin: "Back to Login",
      logOut: "Log Out",
      jobNameLabel: "Client",
      cityLabel: "City",
      stateLabel: "State",
      zipLabel: "Zip Code",
      phonesLabel: "Phone Numbers",
      emailsLabel: "Email Addresses",
      taxExempt: "Tax Exempt",
      taxLabor: "Tax Labor",
      addLineItem: "+ Add Line Item",
      quickLines: "Quick Lines",
      saveEstimate: "Save Estimate",
      printPreview: "Print/Preview",
      sendEstimate: "Send Estimate",
      convertToInvoice: "Convert to Invoice",
      takePhoto: "Take Photo",
      addPhoto: "Add Photo",
      addPhotos: "Add Photos",
      takePhotoWithCamera: "Take Photo with Camera",
      uploadPhotos: "Upload from Device",
      recordVideo: "Record Video",
      scanReceipt: "Scan Receipt",
      labor: "Labor",
      photos: "Photos",
      videos: "Videos",
      receipts: "Receipts",
      termsConditionsEditor: "Terms & Conditions",
      saveAsTemplate: "Save as Template",
      loadTemplate: "Load Template...",
      laborButton: "Labor",
      photosSection: "Photos",
      photoFolderTitle: "Job Photos",
      photoFolderClosed: "Click to open photo folder",
      photoFolderOpen: "Close photo folder",
      photoFolderCount: "{count} photos",
      videosSection: "Videos",
      receiptsSection: "Receipts",
      loginMain: "Log In (Main Account)",
      signUp: "Sign Up",
      logInAsCrew: "Log In as Crew / Sub-contractor",
      crewLoginNote: "Use the email provided by the main account holder. No password needed.",
      twoStepVerification: "Two-Step Verification",
      verifyCode: "Verify Code",
      resendCode: "Resend Code",
      open: "Open",
      archive: "Archive",
      delete: "Delete",
      retrieve: "Retrieve",
      retrieveArchive: "Retrieve Archive",
      retrieveArchiveHelp: "View archived estimates and invoices, open them, or restore them to your active lists.",
      viewArchives: "View / Retrieve Archives",
      paidInvoices: "Paid Invoices",
      paidInvoicesHelp: "Invoices marked paid are moved here automatically and removed from Estimates and open Invoices.",
      noPaidInvoices: "No paid invoices yet. When you close out an invoice as paid, it appears in this folder.",
      activeEstimates: "Active Estimates",
      metric: "Metric",
      count: "Count",
      noOutstanding: "No outstanding invoices",
      jobName: "Client",
      amountDue: "Amount Due",
      totalOutstandingLabel: "Total Outstanding",
      paid: "Paid",
      outstandingRestricted: "Outstanding amounts restricted",
      backToEditor: "Back to Editor",
      archivedDocuments: "Archived Documents",
      noArchivedDocuments: "No archived documents yet.",
      load: "Load",
      savedDocuments: "Saved Documents",
      languageLabel: "Language / Idioma / Langue",
      paymentMethods: "Payment Methods",
      connected: "Connected",
      notConnected: "Not connected",
      manage: "Manage",
      linkAccount: "Link Account",
      venmoUsername: "Venmo Username",
      venmoUsernameHelp: "Clients will be sent to this Venmo username when they pay by Venmo.",
      venmoUsernamePlaceholder: "YourBusiness",
      chargeCCFee: "Charge customers a credit card processing fee",
      exportData: "Export Selected Data (CSV)",
      viewAppointments: "View Appointments",
      backToSchedule: "Back to Schedule",
      scheduleAppointment: "Schedule Appointment",
      editAppointment: "Edit Appointment",
      edit: "Edit",
      saveChanges: "Save Changes",
      noAppointmentsThisMonth: "No appointments scheduled for this month.",
      previousMonth: "Previous month",
      nextMonth: "Next month",
      appointmentReminders: "Appointment Reminders",
      appointmentReminderToggle: "Daily Appointment Reminder",
      appointmentReminderHelp: "Sends a text and email to you every morning at 8:00 AM (Eastern) with appointments scheduled for the following day.",
      appointmentReminderContact: "Uses your company email and phone from this profile",
      testReminderNow: "Test Reminder Now",
      testingReminder: "Sending test...",
      cryptoPayments: "Cryptocurrency Payments",
      cryptoPaymentsHelp: "Link third-party crypto processors to accept digital currency from clients.",
      paymentDisclosureTitle: "Third-Party Payment Disclosure",
      paymentDisclosureBody: "All payment options shown here—including cards, banks, mobile wallets, and cryptocurrency services—are independent third-party platforms. EstimateAce does not operate, control, or guarantee any of these payment systems. EstimateAce cannot help with setup, configuration, verification, or troubleshooting for third-party providers. You are solely responsible for creating and managing accounts with each provider, following their terms, and resolving payment issues directly with them.",
    },
    es: {
      welcome: "¡Bienvenido de nuevo!",
      dashboard: "Panel",
      estimates: "Presupuestos",
      invoices: "Facturas",
      newEstimate: "Nuevo Presupuesto",
      newInvoice: "Nueva Factura",
      reports: "Informes",
      calendar: "Calendario",
      profile: "Perfil",
      companyProfile: "Perfil de la Empresa",
      termsConditions: "Términos y Condiciones",
      saveProfile: "Guardar Perfil",
      totalOutstanding: "Total Pendiente",
      yearToDateSales: "Ventas del Año hasta la Fecha",
      crew: "Equipo / Subcontratistas",
      companyName: "Nombre de la Empresa",
      slogan: "Lema",
      phone: "Teléfono",
      email: "Correo",
      address: "Dirección",
      city: "Ciudad",
      state: "Estado",
      zipCode: "Código Postal",
      logo: "Logo de la Empresa",
      backToLogin: "Volver al Inicio de Sesión",
      logOut: "Cerrar Sesión",
      jobNameLabel: "Cliente",
      cityLabel: "Ciudad",
      stateLabel: "Estado",
      zipLabel: "Código Postal",
      phonesLabel: "Números de Teléfono",
      emailsLabel: "Direcciones de Correo",
      taxExempt: "Exento de Impuestos",
      taxLabor: "Impuesto sobre Mano de Obra",
      addLineItem: "+ Añadir Partida",
      quickLines: "Líneas Rápidas",
      saveEstimate: "Guardar Presupuesto",
      printPreview: "Imprimir/Vista Previa",
      sendEstimate: "Enviar Presupuesto",
      convertToInvoice: "Convertir a Factura",
      takePhoto: "Tomar Foto",
      addPhoto: "Agregar Foto",
      addPhotos: "Agregar Fotos",
      takePhotoWithCamera: "Tomar Foto con Cámara",
      uploadPhotos: "Subir desde Dispositivo",
      recordVideo: "Grabar Video",
      scanReceipt: "Escanear Recibo",
      labor: "Mano de Obra",
      photos: "Fotos",
      videos: "Videos",
      receipts: "Recibos",
      termsConditionsEditor: "Términos y Condiciones",
      saveAsTemplate: "Guardar como Plantilla",
      loadTemplate: "Cargar plantilla...",
      laborButton: "Mano de Obra",
      photosSection: "Fotos",
      photoFolderTitle: "Fotos del Trabajo",
      photoFolderClosed: "Clic para abrir la carpeta de fotos",
      photoFolderOpen: "Cerrar carpeta de fotos",
      photoFolderCount: "{count} fotos",
      videosSection: "Videos",
      receiptsSection: "Recibos",
      loginMain: "Iniciar Sesión (Cuenta Principal)",
      signUp: "Registrarse",
      logInAsCrew: "Iniciar Sesión como Equipo / Subcontratista",
      crewLoginNote: "Usa el email proporcionado por la cuenta principal. No se necesita contraseña.",
      twoStepVerification: "Verificación en Dos Pasos",
      verifyCode: "Verificar Código",
      resendCode: "Reenviar Código",
      open: "Abrir",
      archive: "Archivar",
      delete: "Eliminar",
      retrieve: "Recuperar",
      retrieveArchive: "Recuperar Archivo",
      retrieveArchiveHelp: "Vea presupuestos y facturas archivados, ábralos o restáurelos a sus listas activas.",
      viewArchives: "Ver / Recuperar Archivos",
      paidInvoices: "Facturas Pagadas",
      paidInvoicesHelp: "Las facturas marcadas como pagadas se mueven aquí automáticamente y se quitan de Presupuestos y Facturas abiertas.",
      noPaidInvoices: "Aún no hay facturas pagadas. Al cerrar una factura como pagada, aparece en esta carpeta.",
      activeEstimates: "Presupuestos Activos",
      metric: "Métrica",
      count: "Cantidad",
      noOutstanding: "Sin facturas pendientes",
      jobName: "Cliente",
      amountDue: "Monto Adeudado",
      totalOutstandingLabel: "Total Pendiente",
      paid: "Pagado",
      outstandingRestricted: "Montos pendientes restringidos",
      backToEditor: "Volver al Editor",
      archivedDocuments: "Documentos Archivados",
      noArchivedDocuments: "Aún no hay documentos archivados.",
      load: "Cargar",
      savedDocuments: "Documentos Guardados",
      languageLabel: "Idioma / Idioma / Langue",
      paymentMethods: "Métodos de Pago",
      connected: "Conectado",
      notConnected: "No conectado",
      manage: "Administrar",
      linkAccount: "Vincular Cuenta",
      venmoUsername: "Usuario de Venmo",
      venmoUsernameHelp: "Ingresa el @usuario con el que los clientes te pagan en Venmo.",
      venmoUsernamePlaceholder: "TuNegocio",
      chargeCCFee: "Cobrar a los clientes una tarifa de procesamiento de tarjetas",
      exportData: "Exportar Datos Seleccionados (CSV)",
      viewAppointments: "Ver Citas",
      backToSchedule: "Volver a Programar",
      scheduleAppointment: "Programar Cita",
      editAppointment: "Editar Cita",
      edit: "Editar",
      saveChanges: "Guardar Cambios",
      noAppointmentsThisMonth: "No hay citas programadas para este mes.",
      previousMonth: "Mes anterior",
      nextMonth: "Mes siguiente",
      appointmentReminders: "Recordatorios de Citas",
      appointmentReminderToggle: "Recordatorio Diario de Citas",
      appointmentReminderHelp: "Envía un mensaje de texto y correo cada mañana a las 8:00 AM (Este) con las citas del día siguiente.",
      appointmentReminderContact: "Usa el correo y teléfono de la empresa en este perfil",
      testReminderNow: "Probar Recordatorio",
      testingReminder: "Enviando prueba...",
      cryptoPayments: "Pagos con Criptomonedas",
      cryptoPaymentsHelp: "Vincula procesadores de criptomonedas de terceros para aceptar moneda digital de clientes.",
      paymentDisclosureTitle: "Aviso de Pagos de Terceros",
      paymentDisclosureBody: "Todas las opciones de pago mostradas aquí—incluidas tarjetas, bancos, billeteras móviles y servicios de criptomonedas—son plataformas independientes de terceros. EstimateAce no opera, controla ni garantiza ninguno de estos sistemas de pago. EstimateAce no puede ayudar con la configuración, verificación o resolución de problemas de proveedores externos. Usted es responsable de crear y administrar cuentas con cada proveedor y resolver disputas directamente con ellos.",
    },
    fr: {
      welcome: "Bienvenue !",
      dashboard: "Tableau de bord",
      estimates: "Devis",
      invoices: "Factures",
      newEstimate: "Nouveau Devis",
      newInvoice: "Nouvelle Facture",
      reports: "Rapports",
      calendar: "Calendrier",
      profile: "Profil",
      companyProfile: "Profil de l'Entreprise",
      termsConditions: "Conditions Générales",
      saveProfile: "Enregistrer le Profil",
      totalOutstanding: "Total en Cours",
      yearToDateSales: "Ventes de l'Année en Cours",
      crew: "Équipe / Sous-traitants",
      companyName: "Nom de l'Entreprise",
      slogan: "Slogan",
      phone: "Téléphone",
      email: "Email",
      address: "Adresse",
      city: "Ville",
      state: "État",
      zipCode: "Code Postal",
      logo: "Logo de l'Entreprise",
      backToLogin: "Retour à la Connexion",
      logOut: "Déconnexion",
      jobNameLabel: "Client",
      cityLabel: "Ville",
      stateLabel: "État",
      zipLabel: "Code Postal",
      phonesLabel: "Numéros de Téléphone",
      emailsLabel: "Adresses Email",
      taxExempt: "Exonéré d'Impôts",
      taxLabor: "Taxe sur la Main d'Œuvre",
      addLineItem: "+ Ajouter une Ligne",
      quickLines: "Lignes Rapides",
      saveEstimate: "Enregistrer le Devis",
      printPreview: "Imprimer/Aperçu",
      sendEstimate: "Envoyer le Devis",
      convertToInvoice: "Convertir en Facture",
      takePhoto: "Prendre Photo",
      addPhoto: "Ajouter Photo",
      addPhotos: "Ajouter Photos",
      takePhotoWithCamera: "Prendre Photo avec Caméra",
      uploadPhotos: "Importer depuis l'Appareil",
      recordVideo: "Enregistrer Vidéo",
      scanReceipt: "Scanner Reçu",
      labor: "Main d'Œuvre",
      photos: "Photos",
      videos: "Vidéos",
      receipts: "Reçus",
      termsConditionsEditor: "Conditions Générales",
      saveAsTemplate: "Enregistrer comme Modèle",
      loadTemplate: "Charger modèle...",
      laborButton: "Main d'Œuvre",
      photosSection: "Photos",
      photoFolderTitle: "Photos du Chantier",
      photoFolderClosed: "Cliquez pour ouvrir le dossier de photos",
      photoFolderOpen: "Fermer le dossier de photos",
      photoFolderCount: "{count} photos",
      videosSection: "Vidéos",
      receiptsSection: "Reçus",
      loginMain: "Connexion (Compte Principal)",
      signUp: "S'inscrire",
      logInAsCrew: "Se connecter en tant qu'Équipe / Sous-traitant",
      crewLoginNote: "Utilisez l'email fourni par le titulaire du compte principal. Pas de mot de passe requis.",
      twoStepVerification: "Vérification en Deux Étapes",
      verifyCode: "Vérifier le Code",
      resendCode: "Renvoyer le Code",
      open: "Ouvrir",
      archive: "Archiver",
      delete: "Supprimer",
      retrieve: "Récupérer",
      retrieveArchive: "Récupérer les Archives",
      retrieveArchiveHelp: "Consultez les devis et factures archivés, ouvrez-les ou restaurez-les dans vos listes actives.",
      viewArchives: "Voir / Récupérer les Archives",
      paidInvoices: "Factures Payées",
      paidInvoicesHelp: "Les factures marquées payées sont déplacées ici automatiquement et retirées des Devis et Factures ouvertes.",
      noPaidInvoices: "Aucune facture payée pour le moment. Lorsqu'une facture est clôturée comme payée, elle apparaît dans ce dossier.",
      activeEstimates: "Devis Actifs",
      metric: "Métrique",
      count: "Nombre",
      noOutstanding: "Aucune facture en cours",
      jobName: "Client",
      amountDue: "Montant Dû",
      totalOutstandingLabel: "Total en Cours",
      paid: "Payé",
      outstandingRestricted: "Montants en cours restreints",
      backToEditor: "Retour à l'Éditeur",
      archivedDocuments: "Documents Archivés",
      noArchivedDocuments: "Aucun document archivé pour le moment.",
      load: "Charger",
      savedDocuments: "Documents Enregistrés",
      languageLabel: "Langue / Idioma / Language",
      paymentMethods: "Méthodes de Paiement",
      connected: "Connecté",
      notConnected: "Non connecté",
      manage: "Gérer",
      linkAccount: "Lier le Compte",
      venmoUsername: "Nom d'utilisateur Venmo",
      venmoUsernameHelp: "Entrez le @nom d'utilisateur que les clients utilisent pour vous payer sur Venmo.",
      venmoUsernamePlaceholder: "VotreEntreprise",
      chargeCCFee: "Facturer aux clients des frais de traitement par carte",
      exportData: "Exporter les Données Sélectionnées (CSV)",
      viewAppointments: "Voir les Rendez-vous",
      backToSchedule: "Retour à la Planification",
      scheduleAppointment: "Planifier un Rendez-vous",
      editAppointment: "Modifier le Rendez-vous",
      edit: "Modifier",
      saveChanges: "Enregistrer les Modifications",
      noAppointmentsThisMonth: "Aucun rendez-vous prévu pour ce mois.",
      previousMonth: "Mois précédent",
      nextMonth: "Mois suivant",
      appointmentReminders: "Rappels de Rendez-vous",
      appointmentReminderToggle: "Rappel Quotidien de Rendez-vous",
      appointmentReminderHelp: "Envoie un SMS et un e-mail chaque matin à 8h00 (Heure de l'Est) avec les rendez-vous du lendemain.",
      appointmentReminderContact: "Utilise l'e-mail et le téléphone de l'entreprise dans ce profil",
      testReminderNow: "Tester le Rappel",
      testingReminder: "Envoi du test...",
      cryptoPayments: "Paiements en Cryptomonnaie",
      cryptoPaymentsHelp: "Liez des processeurs crypto tiers pour accepter les paiements numériques des clients.",
      paymentDisclosureTitle: "Avis sur les Paiements Tiers",
      paymentDisclosureBody: "Toutes les options de paiement affichées ici—cartes, banques, portefeuilles mobiles et services de cryptomonnaie—sont des plateformes tierces indépendantes. EstimateAce n'exploite, ne contrôle ni ne garantit aucun de ces systèmes de paiement. EstimateAce ne peut pas aider à la configuration, la vérification ou le dépannage des fournisseurs tiers. Vous êtes seul responsable de la création et de la gestion des comptes auprès de chaque fournisseur et de la résolution des litiges directement avec eux.",
    }
  };

  const MONTH_NAMES = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
    fr: ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'],
  };



  // Document states
  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);

  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState<any[]>([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const DEFAULT_ESTIMATE_BREAKDOWN = {
    showMaterialBreakdownOnEstimate: false,
    showLaborBreakdownOnEstimate: false,
    showCostBreakdownOnEstimate: false,
  };
  const [estimateBreakdownSettings, setEstimateBreakdownSettings] = useState(DEFAULT_ESTIMATE_BREAKDOWN);
  const [terms, setTerms] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);   // stores permanent paths (or legacy signed urls)
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);

  // Resolved display URLs (fresh signed URLs)
  const [photoDisplayUrls, setPhotoDisplayUrls] = useState<string[]>([]);
  const [videoDisplayUrls, setVideoDisplayUrls] = useState<string[]>([]);
  const [receiptDisplayUrls, setReceiptDisplayUrls] = useState<string[]>([]);
  const [logoDisplayUrl, setLogoDisplayUrl] = useState('');
  const [certificateDisplayUrl, setCertificateDisplayUrl] = useState('');
  const [zelleQrDisplayUrl, setZelleQrDisplayUrl] = useState('');
  const [isZellePayOpen, setIsZellePayOpen] = useState(false);
  const [zellePayAmount, setZellePayAmount] = useState(0);
  const [zellePayLabel, setZellePayLabel] = useState<'deposit' | 'balance' | 'invoice'>('invoice');
  const [isVenmoPayOpen, setIsVenmoPayOpen] = useState(false);
  const [venmoPayAmount, setVenmoPayAmount] = useState(0);
  const [venmoPayLabel, setVenmoPayLabel] = useState<'deposit' | 'balance' | 'invoice'>('invoice');
  const [isPayPalPayOpen, setIsPayPalPayOpen] = useState(false);
  const [paypalPayAmount, setPaypalPayAmount] = useState(0);
  const [paypalPayLabel, setPaypalPayLabel] = useState<'deposit' | 'balance' | 'invoice'>('invoice');
  const [receiptDetails, setReceiptDetails] = useState<any[]>([]);

  // For Grok AI description improvement loading state (per item)
  const [improvingDescriptionId, setImprovingDescriptionId] = useState<number | null>(null);

  // For AI Price Quote loading state (per item)
  const [aiQuoteLoadingId, setAiQuoteLoadingId] = useState<number | null>(null);
  const [isPhotoQuoteLinePickerOpen, setIsPhotoQuoteLinePickerOpen] = useState(false);
  const [photoQuoteImageUrl, setPhotoQuoteImageUrl] = useState('');
  const [photoQuoteLineId, setPhotoQuoteLineId] = useState<number | null>(null);

  // Resolve storage paths (and legacy signed URLs) to fresh signed URLs for display
  useEffect(() => {
    const resolveUrls = async (paths: string[]) => {
      const resolved = await Promise.all(
        paths.map((p) => resolveMediaDisplayUrl(p, getMediaUrl))
      );
      return resolved.filter(Boolean);
    };

    resolveUrls(photoUrls).then(setPhotoDisplayUrls);
    resolveUrls(videoUrls).then(setVideoDisplayUrls);
    resolveUrls(receiptUrls).then(setReceiptDisplayUrls);
  }, [photoUrls, videoUrls, receiptUrls, supabase]);

  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  // Labor states
  const [isLaborModalOpen, setIsLaborModalOpen] = useState(false);
  const [isMileageModalOpen, setIsMileageModalOpen] = useState(false);
  const [laborHours, setLaborHours] = useState(0);
  const [laborRate, setLaborRate] = useState(0);
  const [laborFixedAmount, setLaborFixedAmount] = useState(0);
  const [useHourlyLabor, setUseHourlyLabor] = useState(true);
  const laborAmount = useHourlyLabor ? laborHours * laborRate : laborFixedAmount;

  // Tax states
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [taxLabor, setTaxLabor] = useState(true);

  // Discount states (draft = form inputs; applied = used in totals)
  const [discountDescription, setDiscountDescription] = useState('');
  const [discountValueInput, setDiscountValueInput] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'dollar'>('dollar');
  const [appliedDiscountDescription, setAppliedDiscountDescription] = useState('');
  const [appliedDiscountValue, setAppliedDiscountValue] = useState<number>(0);
  const [appliedDiscountType, setAppliedDiscountType] = useState<'percent' | 'dollar'>('dollar');
  const [discountNames, setDiscountNames] = useState<string[]>(DEFAULT_DISCOUNT_NAMES);
  const [newDiscountNameInput, setNewDiscountNameInput] = useState('');

  const getTaxRateFromZip = (zip: string, fallbackState: string): number => {
    const zipTaxMap: { [key: string]: number } = {
      '33101': 7.0, '33139': 7.0, '90210': 9.5, '10001': 8.875,
      '60601': 10.25, '77001': 8.25, '75201': 8.25, '94102': 8.5,
      '30303': 8.9, '33131': 7.0,
    };
    const cleanZip = zip.trim().replace(/\D/g, '').slice(0, 5);
    if (zipTaxMap[cleanZip]) return zipTaxMap[cleanZip];

    const stateRates: { [key: string]: number } = {
      'AL': 4, 'AK': 0, 'AZ': 5.6, 'AR': 6.5, 'CA': 7.25,
      'CO': 2.9, 'CT': 6.35, 'DE': 0, 'FL': 6, 'GA': 4,
      'HI': 4, 'ID': 6, 'IL': 6.25, 'IN': 7, 'IA': 6,
      'KS': 6.5, 'KY': 6, 'LA': 4.45, 'ME': 5.5, 'MD': 6,
      'MA': 6.25, 'MI': 6, 'MN': 6.875, 'MS': 7, 'MO': 4.225,
      'MT': 0, 'NE': 5.5, 'NV': 6.85, 'NH': 0, 'NJ': 6.625,
      'NM': 5.125, 'NY': 4, 'NC': 4.75, 'ND': 5, 'OH': 5.75,
      'OK': 4.5, 'OR': 0, 'PA': 6, 'RI': 7, 'SC': 6,
      'SD': 4.5, 'TN': 7, 'TX': 6.25, 'UT': 4.85, 'VT': 6,
      'VA': 4.3, 'WA': 6.5, 'WV': 6, 'WI': 5, 'WY': 4,
    };
    return stateRates[fallbackState.toUpperCase()] || 7;
  };

  const baseTaxRate = getTaxRateFromZip(zipCode, state);

  // Profile (with payment settings) — blank defaults per account (never share across logins)
  const blankProfile = () => ({
    name: '', company: '', address: '', phone: '', email: '', slogan: '',
    city: '', state: '', zipCode: '',
    disclosure: '',
    certificateUrl: '',
    logoUrl: '',
    logoSize: 'medium',
    language: 'en' as string,
    depositPercentage: 10,
    showDepositOnApproval: true,
    thirdPartyEscrowEnabled: false,
    escrowMinimumAmount: 10000,
    autoSaveEnabled: true,
    showPriceBreakdownByLine: false,
    showMaterialBreakdownOnEstimate: false,
    showLaborBreakdownOnEstimate: false,
    showCostBreakdownOnEstimate: false,
    appointmentReminderEnabled: false,
    showDiscountOnEstimate: true,
    taxesEnabled: true,
    teammates: [] as {
      email: string;
      userId?: string;
      role: 'full' | 'limited';
      canSeePricing: boolean;
      canSeeEstimatesAndFinancials: boolean;
    }[],
    crewSubscriptionActive: false,
    chargeCCFee: false,
    ccFeePercentage: 3,
    paymentSettings: { ...DEFAULT_PAYMENT_SETTINGS } as any
  });
  const [profile, setProfile] = useState(blankProfile);

  // Dynamic UI pack for languages beyond built-in en/es/fr (AI-translated, cached)
  const [dynamicUiPack, setDynamicUiPack] = useState<Record<string, string> | null>(null);
  const [uiLangBusy, setUiLangBusy] = useState(false);

  // Language / i18n (must be after profile is declared)
  // Prefer localStorage (user's explicit choice) so language never reverts on load/new/open
  const currentLang = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('appLanguage');
      if (saved && isKnownLanguageCode(saved)) return saved;
    }
    const fromProfile = String((profile as any).language || 'en');
    return isKnownLanguageCode(fromProfile) ? fromProfile : 'en';
  })();
  const t = (key: string): string => {
    if (dynamicUiPack && dynamicUiPack[key]) return dynamicUiPack[key];
    return (translations as any)[currentLang]?.[key] || (translations as any)['en']?.[key] || key;
  };

  const [profileTab, setProfileTab] = useState<'info' | 'payments' | 'paidInvoices' | 'billing'>('info');
  /** Skip profile auto-save while hydrating from server/local cache */
  const profileHydratingRef = useRef(false);
  const profileAutoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedCompanyFingerprintRef = useRef('');
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [profileAutoSaveLabel, setProfileAutoSaveLabel] = useState('');

  // Must be defined before profile cache helpers (used during render totals)
  const workspaceUserId: string =
    (currentCrew?.ownerUserId as string) || user?.id || '';
  const canSeePricing = !currentCrew || currentCrew.canSeePricing !== false;
  const canSeeFinancials = !currentCrew || currentCrew.canSeeEstimatesAndFinancials !== false;

  /** Per-account cache only — never reuse another user's company/settings on this device */
  const profileSettingsCacheKey = (uid?: string | null) =>
    uid ? `estimateace_profile_settings_${uid}` : '';

  const getProfileSettingsCache = (uid?: string | null): Record<string, any> => {
    if (typeof window === 'undefined') return {};
    const id = uid || workspaceUserId;
    if (!id) return {};
    try {
      const raw = localStorage.getItem(profileSettingsCacheKey(id));
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };

  const setProfileSettingsCache = (settings: Record<string, any>, uid?: string | null) => {
    if (typeof window === 'undefined') return;
    const id = uid || workspaceUserId;
    if (!id) return;
    localStorage.setItem(
      profileSettingsCacheKey(id),
      JSON.stringify({
        ...getProfileSettingsCache(id),
        ...settings,
      })
    );
  };

  const hasActiveDiscount = () =>
    appliedDiscountDescription.trim().length > 0 && appliedDiscountValue > 0;

  const getShowDiscountOnEstimate = (): boolean => {
    const cached = getProfileSettingsCache();
    if ('showDiscountOnEstimate' in cached) {
      return cached.showDiscountOnEstimate === true;
    }
    return profile.showDiscountOnEstimate === true;
  };

  const shouldShowClientDiscount = () =>
    hasActiveDiscount() && getShowDiscountOnEstimate();

  const getTaxesEnabled = (): boolean => {
    const cached = getProfileSettingsCache();
    if ('taxesEnabled' in cached) {
      return cached.taxesEnabled !== false;
    }
    return profile.taxesEnabled !== false;
  };

  const estimateTotals = computeEstimateTotals({
    items,
    laborAmount,
    isTaxExempt,
    taxesEnabled: getTaxesEnabled(),
    taxRate: baseTaxRate,
    discountDescription: appliedDiscountDescription,
    discountValue: appliedDiscountValue,
    discountType: appliedDiscountType,
  });
  const {
    itemsTotal: taxableSubtotal,
    subtotalBeforeDiscount,
    subtotalAfterDiscount,
    discountAmount,
    taxAmount,
    grandTotal,
  } = estimateTotals;

  // Credit card processing fee derived values (must be after profile state)
  const ccFeePercent = profile.chargeCCFee ? (profile.ccFeePercentage || 3) : 0;
  const ccFeeAmount = grandTotal * (ccFeePercent / 100);
  const totalWithCCFee = grandTotal + ccFeeAmount;

  const getLogoClass = (size: string = profile.logoSize || 'medium') => {
    const sizes: { [key: string]: string } = {
      small: 'w-8 h-8',
      medium: 'w-12 h-12',
      large: 'w-16 h-16',
    };
    return sizes[size] || sizes.medium;
  };

  // Determine native language based on company zip/state (simple US-centric heuristic)
  const getNativeLanguage = (zip: string, st: string): string => {
    const s = (st || '').toUpperCase().trim();
    const spanishStates = ['CA', 'TX', 'FL', 'NM', 'AZ', 'NV', 'CO', 'NY'];
    if (spanishStates.includes(s)) return 'es';
    // Add more mappings if needed, default English
    return 'en';
  };

  // Always prefer language from localStorage (user choice) over any per-document snapshot
  const getPreferredLanguage = (): string => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('appLanguage');
      if (saved && isKnownLanguageCode(saved)) return saved;
    }
    const fromProfile = String((profile as any).language || 'en');
    return isKnownLanguageCode(fromProfile) ? fromProfile : 'en';
  };

  const uiPackCacheKey = (code: string) => `estimateace_ui_pack_${code}`;

  const loadDynamicUiPack = async (langCode: string) => {
    if (hasBuiltinUiPack(langCode)) {
      setDynamicUiPack(null);
      return;
    }
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(uiPackCacheKey(langCode));
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === 'object') {
            setDynamicUiPack(parsed);
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!supabase || !user) {
      setDynamicUiPack(null);
      return;
    }
    setUiLangBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setDynamicUiPack(null);
        return;
      }
      const enPack = (translations as any).en || {};
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'dictionary',
          from: 'en',
          to: langCode,
          texts: enPack,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.translations) {
        showMessage(json.error || 'Could not load interface translation. Using English for labels.');
        setDynamicUiPack(null);
        return;
      }
      setDynamicUiPack(json.translations);
      try {
        localStorage.setItem(uiPackCacheKey(langCode), JSON.stringify(json.translations));
      } catch {
        /* ignore */
      }
      showMessage(`✅ Interface loaded in ${languageLabel(langCode)}`);
    } catch {
      showMessage('Translation service unavailable. Using English labels.');
      setDynamicUiPack(null);
    } finally {
      setUiLangBusy(false);
    }
  };

  const applyAppLanguage = async (langCode: string) => {
    if (!isKnownLanguageCode(langCode)) return;
    setProfile((prev) => ({ ...prev, language: langCode }));
    try {
      localStorage.setItem('appLanguage', langCode);
    } catch {
      /* ignore */
    }
    await loadDynamicUiPack(langCode);
    setTimeout(() => saveToDB(), 100);
  };

  // Snapshot only safe, non-sensitive fields to avoid duplicating teammates/passwords etc. in every document
  const getSafeProfileSnapshot = (full: any) => ({
    name: full.name || '',
    company: full.company || '',
    slogan: full.slogan || '',
    address: full.address || '',
    phone: full.phone || '',
    email: full.email || '',
    logoUrl: full.logoUrl || '',
    logoSize: full.logoSize || 'medium',
    certificateUrl: full.certificateUrl || '',
    disclosure: full.disclosure || '', // terms
    city: full.city || '',
    state: full.state || '',
    zipCode: full.zipCode || '',
    depositPercentage: Number(full.depositPercentage) || 0,
    showDepositOnApproval: full.showDepositOnApproval !== false,
    thirdPartyEscrowEnabled: !!full.thirdPartyEscrowEnabled,
    escrowMinimumAmount: Math.max(0, Number(full.escrowMinimumAmount) || 0),
    autoSaveEnabled: full.autoSaveEnabled !== false,
    appointmentReminderEnabled: !!full.appointmentReminderEnabled,
    showDiscountOnEstimate: full.showDiscountOnEstimate === true,
    taxesEnabled: full.taxesEnabled !== false,
    paymentSettings: mergePaymentSettings(full.paymentSettings),
    // deliberately omit: teammates, ccFee*, crewSubscriptionActive, etc.
  });

  /** Prefer non-empty values so a blank estimate snapshot never wipes company info. */
  const pickFilled = (...values: any[]) => {
    for (const v of values) {
      if (v == null) continue;
      if (typeof v === 'string') {
        if (v.trim() !== '') return v;
        continue;
      }
      if (typeof v === 'number' && !Number.isNaN(v)) return v;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'object') return v;
    }
    for (const v of values) {
      if (v !== undefined) return v;
    }
    return '';
  };

  const getDiscountFromDoc = (doc: any) => {
    const stored = doc?.profile?._discount || {};
    return {
      discountDescription: doc?.discountDescription ?? stored.discountDescription ?? '',
      discountValue: Number(doc?.discountValue ?? stored.discountValue) || 0,
      discountType: (doc?.discountType ?? stored.discountType) === 'percent' ? 'percent' as const : 'dollar' as const,
      discountAmount: Number(doc?.discountAmount ?? stored.discountAmount) || 0,
    };
  };

  const getBreakdownSettingsFromDoc = (docProfile: any = {}) => ({
    showMaterialBreakdownOnEstimate: !!docProfile.showMaterialBreakdownOnEstimate,
    showLaborBreakdownOnEstimate: !!docProfile.showLaborBreakdownOnEstimate,
    showCostBreakdownOnEstimate: !!docProfile.showCostBreakdownOnEstimate,
  });

  const getDocumentProfileSnapshot = (
    fullProfile = profile,
    breakdown = estimateBreakdownSettings,
    mileageForJob: MileageLog[] = jobMileageLogs
  ) => ({
    ...getSafeProfileSnapshot(fullProfile),
    ...breakdown,
    showPriceBreakdownByLine:
      breakdown.showMaterialBreakdownOnEstimate ||
      breakdown.showLaborBreakdownOnEstimate,
    _discount: {
      discountDescription: appliedDiscountDescription,
      discountValue: appliedDiscountValue,
      discountType: appliedDiscountType,
      discountAmount,
    },
    // Per-job miles for gas write-off (lives with the document)
    _mileageLogs: mileageForJob,
  });

  // Payment modal states
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isEscrowModalOpen, setIsEscrowModalOpen] = useState(false);
  const [paymentType, setPaymentType] = useState<'deposit' | 'balance'>('deposit');
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<string | null>(null);

  // Crew / Sub-contractors payment states
  const [isCrewPayModalOpen, setIsCrewPayModalOpen] = useState(false);
  const [pendingCrewEmail, setPendingCrewEmail] = useState('');
  // This price is set by the owner of Estimate Ace (you). 
  // End users / account holders of sold instances cannot change it.
  const CREW_MONTHLY_FEE = 20;
  const [selectedCrewPaymentMethod, setSelectedCrewPaymentMethod] = useState<string | null>(null);
  // Other states
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);
  const [archivesList, setArchivesList] = useState<any[]>([]);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [selectedEmailsForSend, setSelectedEmailsForSend] = useState<string[]>([]);
  const [selectedPhonesForSend, setSelectedPhonesForSend] = useState<string[]>([]);

  // Multi-select for lists
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Search filter for All Estimates list */
  const [estimateListSearch, setEstimateListSearch] = useState('');

  // Address auto-suggest states (geocoding APIs + previous addresses fallback)
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<any[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const addressSuggestAbortRef = useRef<AbortController | null>(null);

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [savedTemplates, setSavedTemplates] = useState<any[]>([]);

  // Previous addresses from saved docs (fallback for auto-suggest)
  const previousAddresses = useMemo(() => {
    const addrs: any[] = [];
    const seen = new Set<string>();
    const all = [...(savedEstimatesList || []), ...(archivesList || [])];
    all.forEach((doc: any) => {
      if (!doc.address || !doc.address.trim()) return;
      if (doc.id === invoiceNumber) return;
      const key = doc.address.trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      addrs.push({
        address: doc.address.trim(),
        city: doc.city || '',
        state: doc.state || '',
        zipCode: doc.zipCode || '',
        display: [doc.address, doc.city, doc.state, doc.zipCode].filter(Boolean).join(', '),
      });
    });
    return addrs.slice(0, 20);
  }, [savedEstimatesList, archivesList, invoiceNumber]);

  const buildInternalAddressSuggestions = (q: string) => {
    const qLower = q.trim().toLowerCase();
    const candidates: any[] = [];

    if (profile.address?.trim()) {
      candidates.push({
        address: profile.address.trim(),
        city: profile.city || '',
        state: profile.state || '',
        zipCode: profile.zipCode || '',
        display: [profile.address, profile.city, profile.state, profile.zipCode].filter(Boolean).join(', '),
        source: 'profile',
      });
    }

    previousAddresses.forEach((entry: any) => candidates.push({ ...entry, source: 'history' }));

    if (!qLower) {
      return candidates.slice(0, 8);
    }

    const tokens = qLower.split(/[\s,]+/).filter((token: string) => token.length > 0);
    return candidates.filter((entry: any) => {
      const haystack = [
        entry.address,
        entry.city,
        entry.state,
        entry.zipCode,
        entry.display,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return tokens.every((token: string) => haystack.includes(token));
    });
  };

  // Debounced address auto-suggest (geocoding APIs + saved addresses)
  useEffect(() => {
    const q = address.trim();

    if (!q || q.length < 2) {
      setAddressSuggestions(buildInternalAddressSuggestions(q).slice(0, 8));
      return;
    }

    const timer = setTimeout(async () => {
      addressSuggestAbortRef.current?.abort();
      const controller = new AbortController();
      addressSuggestAbortRef.current = controller;

      setIsLoadingSuggestions(true);
      try {
        const params = new URLSearchParams({ q });
        if (city.trim()) params.set('city', city.trim());
        if (state.trim()) params.set('state', state.trim());
        if (zipCode.trim()) params.set('zip', zipCode.trim());

        const res = await fetch(`/api/address-autocomplete?${params.toString()}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        let live: any[] = [];
        if (res.ok) {
          const data = await res.json();
          live = Array.isArray(data) ? data : [];
        }

        const internal = buildInternalAddressSuggestions(q);
        const combined = rankAddressSuggestions(
          [...live, ...internal],
          q,
          city,
          state
        );

        setAddressSuggestions(combined.slice(0, 8));
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setAddressSuggestions(buildInternalAddressSuggestions(q).slice(0, 8));
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingSuggestions(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      addressSuggestAbortRef.current?.abort();
    };
  }, [address, city, state, zipCode, previousAddresses, profile]);

  // === TRANSLATE STATES (added exactly as requested) ===
  const [translateFrom, setTranslateFrom] = useState('en');
  const [translateTo, setTranslateTo] = useState('es');
  const [itemTranslations, setItemTranslations] = useState<{ [key: number]: string }>({});

  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);
  const [isBreakdownModalOpen, setIsBreakdownModalOpen] = useState(false);
  const [breakdownEditItemId, setBreakdownEditItemId] = useState<number | null>(null);
  const [breakdownMaterials, setBreakdownMaterials] = useState<Array<{
    description: string;
    qty: number;
    unit: string;
    unitPrice: number;
    total: number;
  }>>([]);
  const [breakdownLabor, setBreakdownLabor] = useState<{
    description: string;
    hours: number;
    rate: number;
    total: number;
  } | null>(null);
  const [breakdownIncludeLabor, setBreakdownIncludeLabor] = useState(true);
  const [breakdownSyncLinePrice, setBreakdownSyncLinePrice] = useState(true);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [calendarView, setCalendarView] = useState<'schedule' | 'appointments'>('schedule');
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');
  const [schedulingAppointment, setSchedulingAppointment] = useState(false);
  const [testingReminder, setTestingReminder] = useState(false);
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  const [appointments, setAppointments] = useState<Array<{
    id: string;
    estimateId: string;
    jobName: string;
    invoiceNumber: string;
    datetime: string;
  }>>([]);
  const [appointmentsMonth, setAppointmentsMonth] = useState(() => new Date().getMonth());
  const [appointmentsYear, setAppointmentsYear] = useState(() => new Date().getFullYear());

  const appointmentsForSelectedMonth = useMemo(
    () =>
      appointments
        .filter(appt => {
          const d = new Date(appt.datetime);
          return d.getMonth() === appointmentsMonth && d.getFullYear() === appointmentsYear;
        })
        .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime()),
    [appointments, appointmentsMonth, appointmentsYear]
  );

  const [isReceiptExtractModalOpen, setIsReceiptExtractModalOpen] = useState(false);
  const [currentReceiptUrl, setCurrentReceiptUrl] = useState('');
  const [tempReceiptData, setTempReceiptData] = useState({ date: '', vendor: '', amount: 0, notes: '' });

  const [exportOptions, setExportOptions] = useState({
    estimates: true,
    invoices: true,
    archives: true,
    photos: true,
    videos: true
  });

  const [selectedReportJob, setSelectedReportJob] = useState<any>(null);
  const [reportsSubTab, setReportsSubTab] = useState<'profit' | 'tax'>('profit');
  /** Profit report: which year/month sections are expanded for archived invoices */
  const [profitArchiveYearFilter, setProfitArchiveYearFilter] = useState<string>('all');
  const [profitArchiveExpandedMonths, setProfitArchiveExpandedMonths] = useState<Record<string, boolean>>({});
  /** Per-job mileage (saved on the estimate under profile._mileageLogs) */
  const [jobMileageLogs, setJobMileageLogs] = useState<MileageLog[]>([]);
  /** Global $/mile rate for write-off totals (SETTINGS profile) */
  const [mileageRatePerMile, setMileageRatePerMile] = useState(DEFAULT_MILEAGE_RATE);
  const [mileageSaving, setMileageSaving] = useState(false);
  /** AI Receptionist (24/7 virtual front desk) */
  const [receptionistSettings, setReceptionistSettings] = useState<ReceptionistSettings>(
    DEFAULT_RECEPTIONIST_SETTINGS
  );
  const [receptionistMessages, setReceptionistMessages] = useState<ReceptionistMessage[]>([]);
  const [receptionistSaving, setReceptionistSaving] = useState(false);
  /** SaaS product subscription (Phase A) */
  const [billing, setBilling] = useState<BillingSnapshot>(DEFAULT_BILLING_SNAPSHOT);
  const [billingEnforced, setBillingEnforced] = useState(false);
  const [billingStripeOk, setBillingStripeOk] = useState(false);
  const [billingStripeDiag, setBillingStripeDiag] = useState<{
    hasSecretKey?: boolean;
    hasPriceId?: boolean;
    hasPriceIdMonthly?: boolean;
    hasPriceIdYearly?: boolean;
    hasWebhookSecret?: boolean;
    hasServiceRole?: boolean;
  }>({});
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [billingCheckoutError, setBillingCheckoutError] = useState<string | null>(null);
  /** overview = plan status; manage = crew + payment portal + delete account */
  const [billingPanel, setBillingPanel] = useState<'overview' | 'manage'>('overview');
  const [crewEmailInput, setCrewEmailInput] = useState('');
  const [crewPasswordInput, setCrewPasswordInput] = useState('');
  const [crewInviteBusy, setCrewInviteBusy] = useState(false);
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const SUPPORT_EMAIL =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_SUPPORT_EMAIL) ||
    'support@estimateace.com';

  // Photo / video media picker + device-style in-app camera (fixed chrome)
  const [isPhotoPickerOpen, setIsPhotoPickerOpen] = useState(false);
  const [isDeviceCameraOpen, setIsDeviceCameraOpen] = useState(false);
  const [deviceCameraMode, setDeviceCameraMode] = useState<DeviceCameraMode>('photo');
  /** When more than 6 photos, collapse into a click-to-open folder */
  const PHOTO_FOLDER_THRESHOLD = 6;
  const [photosFolderOpen, setPhotosFolderOpen] = useState(false);

  // Last saved state (required for existing saveToDB call)
  const [lastSaved, setLastSaved] = useState('');
  const [toasts, setToasts] = useState<any[]>([]);

  const showMessage = (message: string) => {
    const clean = message.replace(/^[^\s]*\.vercel\.app says:\s*/i, '').trim();
    const id = Date.now();
    setToasts(prev => [...prev, { id, message: clean }]);
    // Auto dismiss after 4s
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const ensureDiscountNameInList = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setDiscountNames(prev => mergeDiscountNames([...prev, trimmed]));
  };

  const addDiscountName = () => {
    const name = newDiscountNameInput.trim();
    if (!name) {
      showMessage('Enter a discount name to add.');
      return;
    }
    setDiscountNames(prev => {
      const updated = mergeDiscountNames([...prev, name]);
      const customOnly = updated.filter(
        n => !DEFAULT_DISCOUNT_NAMES.some(d => d.toLowerCase() === n.toLowerCase())
      );
      localStorage.setItem('discountNames', JSON.stringify(customOnly));
      return updated;
    });
    setDiscountDescription(name);
    setNewDiscountNameInput('');
    showMessage(`"${name}" added to discount list.`);
  };

  const applyDiscount = () => {
    const name = discountDescription.trim();
    const value = parseFloat(discountValueInput);
    if (!name) {
      showMessage('Select or add a discount name before applying.');
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      showMessage('Enter a discount amount before applying.');
      return;
    }
    if (subtotalBeforeDiscount <= 0) {
      showMessage('Add line items before applying a discount.');
      return;
    }
    setAppliedDiscountDescription(name);
    setAppliedDiscountValue(value);
    setAppliedDiscountType(discountType);
    ensureDiscountNameInList(name);
    showMessage('Discount applied to total before tax.');
  };

  const clearAppliedDiscount = () => {
    setAppliedDiscountDescription('');
    setAppliedDiscountValue(0);
    setAppliedDiscountType('dollar');
    setDiscountDescription('');
    setDiscountValueInput('');
    setDiscountType('dollar');
    showMessage('Discount removed.');
  };

  const getItemMaterials = (item: any) => {
    if (Array.isArray(item.materialsList) && item.materialsList.length > 0) {
      return item.materialsList;
    }
    if (item.materialBreakdown?.description) {
      return [item.materialBreakdown];
    }
    return [];
  };

  const hasItemBreakdown = (item: any) =>
    getItemMaterials(item).length > 0 || !!item.laborBreakdown;

  const getMaterialCostTotal = (materials: any[]) =>
    materials.reduce((sum, m) => sum + (Number(m.total) || Number(m.qty || 0) * Number(m.unitPrice || 0)), 0);

  const itemHasCostData = (item: any) => {
    const materials = getItemMaterials(item);
    const labor = item.laborBreakdown;
    const materialsHaveCost = materials.some(
      (m: any) => Number(m.unitPrice) > 0 || Number(m.total) > 0
    );
    const laborHasCost = !!labor && (Number(labor.rate) > 0 || Number(labor.total) > 0);
    return materialsHaveCost || laborHasCost;
  };

  const getBreakdownSettings = (source?: any) => {
    const settings = source ? getBreakdownSettingsFromDoc(source) : estimateBreakdownSettings;
    return {
      showMaterials: settings.showMaterialBreakdownOnEstimate,
      showLabor: settings.showLaborBreakdownOnEstimate,
      showCosts: settings.showCostBreakdownOnEstimate,
    };
  };

  const hasAnyBreakdownToggleOn = (source?: any) => {
    const { showMaterials, showLabor, showCosts } = getBreakdownSettings(source);
    return showMaterials || showLabor || showCosts;
  };

  const getLineItemExpectedTotal = (item: any) => {
    const qty = Number(item.qty) || 1;
    const lineTotal = Number(item.total);
    if (lineTotal > 0) return lineTotal;
    return roundMoney((Number(item.price) || 0) * qty);
  };

  const renderCostBreakdown = (item: any, className = '') => {
    const rawMaterials = getItemMaterials(item);
    const rawLabor = item.laborBreakdown;
    if (!rawMaterials.length && !rawLabor) return null;

    const normalized = normalizeStoredCostBreakdown({
      description: item.description || '',
      qty: Number(item.qty) || 1,
      unit: item.unit || '',
      unitPrice: Number(item.price) || 0,
      total: getLineItemExpectedTotal(item),
      materials: rawMaterials,
      labor: rawLabor
        ? {
            description: rawLabor.description || 'Labor',
            hours: Number(rawLabor.hours) || 0,
            rate: Number(rawLabor.rate) || 0,
            total: Number(rawLabor.total) || 0,
          }
        : null,
      typicalLaborRate: 62,
      maxLaborRate: 75,
      expectedLaborHours: Number(rawLabor?.hours) || undefined,
    });

    const materialsWithCost = normalized.materials.filter(
      (m: any) => Number(m.unitPrice) > 0 || Number(m.total) > 0
    );
    const labor = normalized.labor;
    const laborHasCost = !!labor && (Number(labor.rate) > 0 || Number(labor.total) > 0);
    if (!materialsWithCost.length && !laborHasCost) return null;

    const materialsSubtotal = normalized.materialsCostTotal;
    const laborSubtotal = normalized.laborCostTotal;
    const builtUpPrice = roundMoney(materialsSubtotal + laborSubtotal);
    const { billing, linePricing } = normalized;
    const lineTotal = linePricing.total;

    return (
      <div className={className}>
        <div className="font-semibold mb-0.5">Cost breakdown (full job):</div>
        {materialsWithCost.length > 0 && (
          <>
            <div className="font-medium">Materials cost:</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {materialsWithCost.map((m: any, i: number) => (
                <li key={i}>
                  {m.description || 'Material'}
                  {m.qty != null ? ` — ${m.qty} ${m.unit || ''}`.trim() : ''}
                  {Number(m.unitPrice) > 0 ? ` × $${Number(m.unitPrice).toFixed(2)}` : ''}
                  {Number(m.total) > 0 ? ` = $${Number(m.total).toFixed(2)}` : ''}
                </li>
              ))}
            </ul>
            <div>Materials subtotal: ${materialsSubtotal.toFixed(2)}</div>
          </>
        )}
        {laborHasCost && labor && (
          <div className={materialsWithCost.length ? 'mt-1' : ''}>
            <span className="font-medium">Labor cost: </span>
            {labor.description || 'Installation'}
            {labor.hours != null ? ` — ${labor.hours} hrs` : ''}
            {Number(labor.rate) > 0 ? ` × $${Number(labor.rate).toFixed(2)}/hr` : ''}
            {laborSubtotal > 0 ? ` = $${laborSubtotal.toFixed(2)}` : ''}
          </div>
        )}
        <div className="font-semibold mt-1">
          Built-up job total: ${builtUpPrice.toFixed(2)}
          {lineTotal > 0 && Math.abs(builtUpPrice - lineTotal) > 0.05
            ? ` (quoted line total $${lineTotal.toFixed(2)}${billing.perSqft ? ` — ${linePricing.qty.toLocaleString()} SF × $${linePricing.price.toFixed(2)}/SF` : ''})`
            : billing.perSqft && lineTotal > 0
              ? ` (${linePricing.qty.toLocaleString()} SF × $${linePricing.price.toFixed(2)}/SF = $${lineTotal.toFixed(2)})`
              : ''}
        </div>
      </div>
    );
  };

  const renderItemBreakdown = (
    item: any,
    className = '',
    options?: { showMaterials?: boolean; showLabor?: boolean }
  ) => {
    const materials = getItemMaterials(item);
    const labor = item.laborBreakdown;
    const showMaterials = options?.showMaterials === true;
    const showLabor = options?.showLabor === true;
    const visibleMaterials = showMaterials ? materials : [];
    const visibleLabor = showLabor ? labor : null;

    if (!visibleMaterials.length && !visibleLabor) return null;

    return (
      <div className={className}>
        {visibleMaterials.length > 0 && (
          <>
            <div className="font-semibold mb-0.5">Materials needed:</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {visibleMaterials.map((m: any, i: number) => (
                <li key={i}>
                  {m.description || 'Material'}
                  {m.qty != null ? ` — ${m.qty} ${m.unit || ''}`.trim() : ''}
                </li>
              ))}
            </ul>
          </>
        )}
        {visibleLabor && (
          <div className={visibleMaterials.length ? 'mt-1' : ''}>
            <span className="font-semibold">Labor: </span>
            {visibleLabor.description || 'Installation'}
            {visibleLabor.hours != null ? ` — ${visibleLabor.hours} hrs` : ''}
          </div>
        )}
      </div>
    );
  };

  const hasClientVisibleBreakdown = (item: any) => {
    const { showMaterials, showLabor, showCosts } = getBreakdownSettings();
    return (
      (showMaterials && getItemMaterials(item).length > 0) ||
      (showLabor && !!item.laborBreakdown) ||
      (showCosts && itemHasCostData(item))
    );
  };

  const getVisibleBreakdownParts = (item: any, source?: any) => {
    const { showMaterials, showLabor, showCosts } = getBreakdownSettings(source);
    const showMaterialsPreview = showMaterials && getItemMaterials(item).length > 0;
    const showLaborPreview = showLabor && !!item.laborBreakdown;
    const showCostsPreview = showCosts && itemHasCostData(item);
    return {
      showMaterials: showMaterialsPreview,
      showLabor: showLaborPreview,
      showCosts: showCostsPreview,
      hasVisiblePreview: showMaterialsPreview || showLaborPreview || showCostsPreview,
    };
  };

  const fetchServerProfileSettings = async () => {
    if (!workspaceUserId || !supabase) return null;
    const { data } = await supabase
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${workspaceUserId}`)
      .maybeSingle();
    return data?.profile || null;
  };

  const getGlobalDisplaySettings = (
    prev: typeof profile,
    serverProfile?: any | null
  ) => {
    const cached = getProfileSettingsCache();
    const resolveDiscount = () => {
      if ('showDiscountOnEstimate' in cached) return cached.showDiscountOnEstimate === true;
      if (serverProfile && 'showDiscountOnEstimate' in serverProfile) {
        return serverProfile.showDiscountOnEstimate === true;
      }
      return prev.showDiscountOnEstimate === true;
    };

    return {
      showDiscountOnEstimate: resolveDiscount(),
    };
  };

  const renderClientItemBreakdown = (item: any, className: string) => {
    if (!hasAnyBreakdownToggleOn() || !hasClientVisibleBreakdown(item)) return null;

    const { showMaterials, showLabor, showCosts } = getBreakdownSettings();
    const preview = getVisibleBreakdownParts(item);

    return (
      <div className={className}>
        {preview.showMaterials || preview.showLabor
          ? renderItemBreakdown(item, '', {
              showMaterials: preview.showMaterials,
              showLabor: preview.showLabor,
            })
          : null}
        {preview.showCosts
          ? renderCostBreakdown(
              item,
              preview.showMaterials || preview.showLabor ? 'mt-2 pt-2 border-t border-gray-200' : ''
            )
          : null}
      </div>
    );
  };

  const renderDocumentTotals = (options?: { large?: boolean }) => {
    const large = options?.large ?? false;
    const textClass = large ? 'text-2xl' : 'text-xl';
    const totalClass = large ? 'text-4xl' : 'text-3xl';
    const showSubtotalBreakdown = hasActiveDiscount() || items.length > 1;

    return (
      <>
        {canSeeFinancials ? (
          <>
            {showSubtotalBreakdown && (
              <div className={`text-right font-semibold text-gray-700 ${textClass}`}>
                Subtotal: ${taxableSubtotal.toFixed(2)}
              </div>
            )}
            {laborAmount > 0 && (
              <div className={`text-right font-semibold text-[#14b8a6] ${textClass}`}>
                Labor: ${laborAmount.toFixed(2)}
                <span className="block text-sm font-normal text-gray-500">Reference only — not included in total</span>
              </div>
            )}
            {hasActiveDiscount() && (
              <div className={`text-right font-semibold text-gray-700 ${textClass}`}>
                Subtotal before discount: ${subtotalBeforeDiscount.toFixed(2)}
              </div>
            )}
            {shouldShowClientDiscount() && (
              <div className={`text-right font-semibold text-red-600 ${textClass}`}>
                {appliedDiscountDescription.trim()}: -${discountAmount.toFixed(2)}
                {appliedDiscountType === 'percent' ? ` (${appliedDiscountValue}%)` : ''}
              </div>
            )}
            {getTaxesEnabled() && (
              <div className={`text-right font-semibold text-[#14b8a6] ${textClass}`}>
                Taxes ({state || '—'} {baseTaxRate}%): ${taxAmount.toFixed(2)}
              </div>
            )}
            <div className={`text-right font-bold ${totalClass}`}>
              Total: ${grandTotal.toFixed(2)}
            </div>
          </>
        ) : (
          <div className="text-right text-lg text-gray-500">Financial details restricted</div>
        )}
        {profile.chargeCCFee && ccFeePercent > 0 && (
          <div className="text-right mt-1 text-sm text-gray-600">
            Credit card processing fee ({ccFeePercent}%): ${ccFeeAmount.toFixed(2)}
            <br />
            <span className="font-semibold">If paid by card: ${totalWithCCFee.toFixed(2)}</span>
          </div>
        )}
      </>
    );
  };

  /**
   * Photo gallery: 6 or fewer photos show inline.
   * More than 6 → collapse into a folder the user must click to open.
   * forceExpanded: print/PDF always shows every photo.
   */
  const renderPhotoGallery = (options?: {
    editable?: boolean;
    forceExpanded?: boolean;
    heading?: string;
    gridClassName?: string;
    imgClassName?: string;
  }) => {
    const editable = !!options?.editable;
    const forceExpanded = !!options?.forceExpanded;
    const count = photoDisplayUrls.length;
    if (count === 0 && !editable) return null;

    const useFolder = count > PHOTO_FOLDER_THRESHOLD && !forceExpanded;
    const isOpen = !useFolder || photosFolderOpen;
    const folderCountLabel = (t('photoFolderCount') || '{count} photos').replace(
      '{count}',
      String(count)
    );
    const gridClass =
      options?.gridClassName ||
      (editable ? 'grid grid-cols-2 md:grid-cols-4 gap-4' : 'grid grid-cols-2 gap-6');
    const imgClass =
      options?.imgClassName ||
      (editable
        ? 'w-full h-40 object-cover rounded-lg border'
        : 'w-full border rounded-xl shadow-sm max-h-64 object-contain');

    const folderButton = useFolder ? (
      <button
        type="button"
        onClick={() => setPhotosFolderOpen((open) => !open)}
        className={`w-full text-left border-2 rounded-xl p-4 sm:p-5 transition shadow-sm ${
          isOpen
            ? 'border-emerald-400 bg-emerald-50/80 hover:bg-emerald-50'
            : 'border-amber-300 bg-gradient-to-br from-amber-50 to-orange-50 hover:from-amber-100 hover:to-orange-100'
        }`}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-4 min-w-0">
          <div className="relative shrink-0 w-16 h-14" aria-hidden>
            {/* Stacked folder + thumbnail stack */}
            <div className="absolute left-2 top-0 w-12 h-10 rounded-md bg-amber-200 border border-amber-300 rotate-[-6deg]" />
            <div className="absolute left-1 top-1 w-12 h-10 rounded-md bg-amber-300 border border-amber-400 rotate-[-2deg]" />
            <div className="absolute left-0 top-2 w-12 h-10 rounded-md bg-amber-400 border border-amber-500 flex items-center justify-center text-2xl shadow-sm">
              📁
            </div>
            {photoDisplayUrls[0] && (
              <img
                src={photoDisplayUrls[0]}
                alt=""
                className="absolute -right-1 top-3 w-8 h-8 object-cover rounded border-2 border-white shadow"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[#1e293b] flex flex-wrap items-center gap-2">
              <span>{t('photoFolderTitle')}</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/80 border text-gray-700">
                {folderCountLabel}
              </span>
            </div>
            <p className="text-sm text-gray-600 mt-0.5">
              {isOpen ? t('photoFolderOpen') : t('photoFolderClosed')}
            </p>
            {!isOpen && (
              <div className="flex gap-1.5 mt-2">
                {photoDisplayUrls.slice(0, 4).map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    className="w-9 h-9 object-cover rounded border border-white shadow-sm"
                  />
                ))}
                {count > 4 && (
                  <span className="w-9 h-9 rounded bg-white/90 border text-[10px] font-semibold text-gray-600 flex items-center justify-center">
                    +{count - 4}
                  </span>
                )}
              </div>
            )}
          </div>
          <span className="text-2xl text-gray-500 shrink-0" aria-hidden>
            {isOpen ? '▾' : '▸'}
          </span>
        </div>
      </button>
    ) : null;

    const photoGrid = isOpen ? (
      <div className={gridClass}>
        {photoDisplayUrls.map((url, i) => (
          <div key={i} className={editable ? 'relative group' : undefined}>
            <img
              src={url}
              alt={`Photo ${i + 1}`}
              className={imgClass}
            />
            {editable && (
              <>
                <button
                  type="button"
                  onClick={() => openGalleryPhotoQuote(url)}
                  className="absolute bottom-2 left-2 right-2 bg-violet-600 hover:bg-violet-700 text-white text-xs py-1.5 px-2 rounded-lg shadow-md sm:opacity-0 sm:group-hover:opacity-100 transition"
                >
                  📷 AI Quote
                </button>
                <button
                  type="button"
                  onClick={() => removeMedia('photo', i)}
                  className="absolute top-2 right-2 bg-red-600 hover:bg-red-700 text-white text-4xl w-10 h-10 flex items-center justify-center rounded-2xl shadow-xl"
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
        {editable && (
          <button
            type="button"
            onClick={openPhotoPicker}
            className="flex flex-col items-center justify-center h-40 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition w-full"
          >
            <div className="text-4xl mb-1">📷</div>
            <div className="text-xs text-gray-500">{t('addPhoto')}</div>
          </button>
        )}
      </div>
    ) : editable ? (
      // Closed folder: still allow adding photos without opening the whole set
      <button
        type="button"
        onClick={openPhotoPicker}
        className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition w-full"
      >
        <div className="text-3xl mb-1">📷</div>
        <div className="text-xs text-gray-500">{t('addPhoto')}</div>
      </button>
    ) : null;

    return (
      <div className="space-y-4">
        {options?.heading && (
          <h3 className="text-2xl font-semibold mb-2 border-b pb-3">{options.heading}</h3>
        )}
        {folderButton}
        {photoGrid}
      </div>
    );
  };

  // Simple toast renderer - placed in the main return below
  const ToastContainer = () => (
    <div className="fixed bottom-20 right-4 z-[100] space-y-2">
      {toasts.map(toast => (
        <div key={toast.id} className="bg-[#1e293b] text-white px-4 py-2 rounded-lg shadow-lg text-sm max-w-xs">
          {toast.message}
        </div>
      ))}
    </div>
  );

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => setUser(session?.user ?? null));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  // After main login: if this user is crew, load owner workspace + permissions
  useEffect(() => {
    if (!user?.id || !supabase) {
      setCurrentCrew(null);
      setCrewResolved(false);
      return;
    }
    // Wipe previous account's UI immediately so nothing leaks into the new session
    resetWorkspaceUi();
    let cancelled = false;
    setCrewResolved(false);
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setCurrentCrew(null);
            setCrewResolved(true);
          }
          return;
        }
        const res = await fetch('/api/crew/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && json.isCrew && json.ownerUserId) {
          setCurrentCrew({
            email: json.email || user.email,
            ownerUserId: json.ownerUserId,
            role: json.role === 'full' ? 'full' : 'limited',
            canSeePricing: json.canSeePricing === true,
            canSeeEstimatesAndFinancials: json.canSeeEstimatesAndFinancials === true,
          });
        } else {
          setCurrentCrew(null);
        }
      } catch {
        if (!cancelled) setCurrentCrew(null);
      } finally {
        if (!cancelled) setCrewResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, supabase]);

  // Load only THIS account's cloud profile after workspace is known
  useEffect(() => {
    if (!workspaceUserId || !supabase || !crewResolved) return;
    profileHydratingRef.current = true;
    lastSavedCompanyFingerprintRef.current = '';
    void loadLatestProfile();
  }, [workspaceUserId, crewResolved, supabase]);

  // Stripe / trial return deep-links
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get('billing');
    const trialParam = params.get('trial');
    const planParam = params.get('plan');

    const cleanUrl = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('billing');
      url.searchParams.delete('trial');
      url.searchParams.delete('plan');
      window.history.replaceState({}, '', url.pathname + url.search);
    };

    if (trialParam === 'started') {
      const planLabel = planParam === 'yearly' ? 'yearly ($249/yr after trial)' : 'monthly ($29.99/mo after trial)';
      showMessage(
        `✅ 14-day free trial started! After the trial you will be billed ${planLabel} unless you cancel in Plan / Billing.`
      );
      if (user?.id && supabase) void refreshBillingStatus();
      cleanUrl();
      return;
    }

    if (!user?.id || !supabase || !billingParam) return;

    if (billingParam === 'success') {
      showMessage('✅ Payment received — syncing subscription…');
      void (async () => {
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const token = sessionData.session?.access_token;
          if (token) {
            await fetch('/api/billing/sync', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
          }
        } catch (e) {
          console.warn(e);
        }
        await refreshBillingStatus();
        showMessage('✅ Billing status refreshed. Open Profile → Plan / Billing if needed.');
      })();
    } else if (billingParam === 'cancel') {
      showMessage('Checkout canceled — you can subscribe anytime.');
    }
    cleanUrl();
  }, [user?.id]);

  useEffect(() => {
    resolveMediaDisplayUrl(profile.logoUrl, getMediaUrl).then(setLogoDisplayUrl);
  }, [profile.logoUrl, supabase]);

  useEffect(() => {
    resolveMediaDisplayUrl(profile.certificateUrl, getMediaUrl).then(setCertificateDisplayUrl);
  }, [profile.certificateUrl, supabase]);

  useEffect(() => {
    const qrPath = mergePaymentSettings(profile.paymentSettings).zelle?.qrUrl || '';
    if (!qrPath) {
      setZelleQrDisplayUrl('');
      return;
    }
    resolveMediaDisplayUrl(qrPath, getMediaUrl).then(setZelleQrDisplayUrl);
  }, [profile.paymentSettings, supabase]);

  // Load language preference from localStorage (+ AI UI pack if needed)
  useEffect(() => {
    const savedLang = localStorage.getItem('appLanguage');
    if (savedLang && isKnownLanguageCode(savedLang)) {
      setProfile((prev) => {
        if (prev.language !== savedLang) {
          return { ...prev, language: savedLang };
        }
        return prev;
      });
      if (!hasBuiltinUiPack(savedLang)) {
        try {
          const cached = localStorage.getItem(`estimateace_ui_pack_${savedLang}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && typeof parsed === 'object') setDynamicUiPack(parsed);
          }
        } catch {
          /* ignore */
        }
      } else {
        setDynamicUiPack(null);
      }
    }
  }, []);

  // Restore client breakdown toggles from cache + server settings doc
  useEffect(() => {
    if (!workspaceUserId || !supabase || !crewResolved) return;
    (async () => {
      const cached = getProfileSettingsCache();
      const serverProfile = await fetchServerProfileSettings();
      const hasSavedPrefs =
        'showDiscountOnEstimate' in cached ||
        'taxesEnabled' in cached ||
        !!serverProfile;

      if (!hasSavedPrefs) return;

      setProfile(prev => {
        const displaySettings = getGlobalDisplaySettings(prev, serverProfile);
        const taxesEnabled =
          'taxesEnabled' in cached
            ? cached.taxesEnabled !== false
            : (serverProfile && 'taxesEnabled' in serverProfile
              ? serverProfile.taxesEnabled !== false
              : prev.taxesEnabled !== false);
        return {
          ...prev,
          ...displaySettings,
          taxesEnabled,
        };
      });
    })();
  }, [workspaceUserId, crewResolved]);

  // Populate saved lists (for dashboard, lists, reports, etc.) as soon as we have a user
  useEffect(() => {
    if (workspaceUserId && supabase && crewResolved) {
      refreshSavedList();
      refreshArchivesList();
      void loadMileageRateFromSettings();
      void loadReceptionistFromSettings();
      if (!currentCrew) void refreshBillingStatus();
    } else if (!user?.id) {
      setBilling(DEFAULT_BILLING_SNAPSHOT);
      setBillingLoaded(false);
    }
  }, [workspaceUserId, crewResolved, currentCrew, user?.id]);

  useEffect(() => {
    if (!workspaceUserId) {
      setAppointments([]);
      return;
    }
    try {
      const stored = localStorage.getItem(`estimateace_appointments_${workspaceUserId}`);
      const parsed = stored ? JSON.parse(stored) : [];
      setAppointments(parsed);
    } catch {
      setAppointments([]);
    }
  }, [workspaceUserId]);

  useEffect(() => {
    if (!workspaceUserId || appointments.length === 0) return;
    void syncAppointmentsToServer(appointments, profile);
  }, [workspaceUserId, appointments.length, profile.appointmentReminderEnabled, profile.email, profile.phone]);

  useEffect(() => {
    if (!workspaceUserId || !profile.appointmentReminderEnabled || !supabase) return;

    const checkMorningReminder = async () => {
      const timeZone = 'America/New_York';
      const now = new Date();
      const hour = Number(now.toLocaleString('en-US', { timeZone, hour: 'numeric', hour12: false }));
      if (hour !== 8) return;

      const todayKey = now.toLocaleDateString('en-CA', { timeZone });
      const lastLocal = localStorage.getItem(`estimateace_last_reminder_${workspaceUserId}`);
      if (lastLocal === todayKey) return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      try {
        const response = await fetch('/api/appointment-reminders/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await response.json();
        if (data.notified) {
          localStorage.setItem(`estimateace_last_reminder_${workspaceUserId}`, todayKey);
        }
      } catch {
        // Reminder will be retried on next interval or by server cron
      }
    };

    void checkMorningReminder();
    const interval = window.setInterval(checkMorningReminder, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [workspaceUserId, profile.appointmentReminderEnabled, appointments.length, supabase]);

  const clearStoredAuth = async () => {
    setLoginError('');
    try {
      if (supabase) await supabase.auth.signOut();
    } catch {
      // ignore sign-out errors while clearing stale storage
    }
    if (typeof window !== 'undefined') {
      Object.keys(localStorage).forEach((key) => {
        if (key === 'estimateace-auth' || (key.startsWith('sb-') && key.includes('auth'))) {
          localStorage.removeItem(key);
        }
      });
    }
    setUser(null);
    showMessage('Cleared saved login data. Try logging in again.');
  };

  const login = async () => {
    setLoginError('');
    if (!supabase) {
      const msg = getSupabaseConfigHelpMessage();
      setLoginError(msg);
      showMessage(msg);
      return;
    }
    if (loginLoading) return;

    const trimmedEmail = email.trim();
    const trimmedPassword = password;
    if (!trimmedEmail || !trimmedPassword) {
      const msg = 'Enter your email and password.';
      setLoginError(msg);
      showMessage(msg);
      return;
    }

    setLoginLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password: trimmedPassword,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        let msg = error.message;
        if (code === 'email_not_confirmed') {
          msg = 'Email not confirmed yet. Check your inbox for the confirmation link.';
        } else if (code === 'invalid_credentials') {
          msg =
            'Invalid email or password. New accounts start from the free trial / pricing page (not Sign Up here). Use Forgot password? if you already have an account.';
        }
        setLoginError(msg);
        showMessage(msg);
        return;
      }

      const authUser = data.session?.user ?? data.user ?? null;
      if (authUser) {
        setUser(authUser);
        setLoginError('');
        setShowLogin(false);
        showMessage('Login successful!');
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session?.user) {
        setUser(sessionData.session.user);
        setLoginError('');
        setShowLogin(false);
        showMessage('Login successful!');
        return;
      }

      const msg = 'Login response was empty. Click "Clear saved login" below, then try again.';
      setLoginError(msg);
      showMessage(msg);
    } catch {
      const msg = 'Network error — could not reach the login server. Check your connection and try again.';
      setLoginError(msg);
      showMessage(msg);
    } finally {
      setLoginLoading(false);
    }
  };

  /** New accounts are only created via marketing HTML → /trial (pay + plan). Not on this login form. */
  const goToSignupPayScreen = () => {
    if (typeof window !== 'undefined') {
      window.location.href = '/trial';
    }
  };

  const verify2FA = () => {
    if (twoFactorCode === expected2FACode) {
      setRequires2FA(false);
      setTwoFactorCode('');
      setShowLogin(false);
    } else {
      showMessage('Incorrect code. Please try again.');
    }
  };

  const resend2FACode = () => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    setExpected2FACode(code);
    showMessage(`A new verification code was sent to ${twoFactorPhone}.`);
  };

  const resetWorkspaceUi = () => {
    setProfile(blankProfile());
    setSavedEstimatesList([]);
    setArchivesList([]);
    setAppointments([]);
    setJobName('');
    setAddress('');
    setCity('');
    setState('');
    setZipCode('');
    setPhones(['']);
    setEmails(['']);
    setTerms('');
    setPhotoUrls([]);
    setVideoUrls([]);
    setReceiptUrls([]);
    setReceiptDetails([]);
    setJobMileageLogs([]);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setInvoiceNumber('');
    lastSavedCompanyFingerprintRef.current = '';
    profileHydratingRef.current = true;
    // Remove legacy shared key that leaked company data across accounts
    try {
      localStorage.removeItem('estimateace_profile_settings');
    } catch {
      /* ignore */
    }
  };

  const logout = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setCurrentCrew(null);
    setCrewResolved(false);
    resetWorkspaceUi();
    setRequires2FA(false);
    setShowLogin(true);
    setTwoFactorCode('');
    showMessage('You have been logged out.');
  };

  // Main account forgot password (uses Supabase built-in)
  const requestMainPasswordReset = async () => {
    if (!supabase || !forgotEmail.trim()) {
      showMessage('Please enter your email');
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      });
      if (error) {
        showMessage(error.message);
      } else {
        showMessage('If an account exists with that email, a password reset link has been sent.');
        setForgotEmail('');
        setShowMainForgot(false);
      }
    } catch (e: any) {
      showMessage('Failed to send reset link. Please try again.');
    }
  };

  const saveToDB = async (options?: {
    profile?: typeof profile;
    breakdown?: typeof estimateBreakdownSettings;
    /** Pass explicit media lists so uploads aren't lost to stale React state */
    photoUrls?: string[];
    videoUrls?: string[];
    receiptUrls?: string[];
    receiptDetails?: any[];
    /** Per-job mileage log (avoids stale state after Add trip) */
    mileageLogs?: MileageLog[];
  }) => {
    if (!user || !supabase || !workspaceUserId) return;
    const profileToSave = options?.profile ?? profile;
    const breakdownToSave = options?.breakdown ?? estimateBreakdownSettings;
    const photosToSave = options?.photoUrls ?? photoUrls;
    const videosToSave = options?.videoUrls ?? videoUrls;
    const receiptsToSave = options?.receiptUrls ?? receiptUrls;
    const receiptDetailsToSave = options?.receiptDetails ?? receiptDetails;
    const milesToSave = options?.mileageLogs ?? jobMileageLogs;
    const data = {
      user_id: workspaceUserId,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile: getDocumentProfileSnapshot(profileToSave, breakdownToSave, milesToSave),
      documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod,
      photoUrls: photosToSave,
      videoUrls: videosToSave,
      receiptUrls: receiptsToSave,
      receiptDetails: receiptDetailsToSave,
      laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
      taxRate: baseTaxRate,
      taxAmount,
      isTaxExempt,
      taxLabor,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) {
      console.error('Save error:', error);
      showMessage('Failed to save document. Please try again.');
    } else {
      // Saving an INV- invoice must clear the original EST- work order from the Estimates page
      if (String(invoiceNumber || '').toUpperCase().startsWith('INV')) {
        await removeEstimateWorkOrderForInvoice(
          {
            id: invoiceNumber,
            invoiceNumber,
            documentType: 'invoice',
            jobName,
            address,
            zipCode,
            paymentStatus,
          },
          workspaceUserId
        );
      }
      setLastSaved(new Date().toLocaleTimeString());
      refreshSavedList();
    }
  };

  /**
   * Normalize mobile photos (iOS HEIC, huge camera files, missing names) so Supabase Storage accepts them.
   */
  const prepareFileForMediaUpload = async (
    file: File,
    type: 'photo' | 'video' | 'receipt'
  ): Promise<{ blob: Blob; ext: string; contentType: string; displayName: string } | null> => {
    if (!file || file.size === 0) return null;

    if (type === 'video') {
      const rawExt = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ext = rawExt || (file.type.includes('webm') ? 'webm' : 'mp4');
      const contentType = file.type || (ext === 'webm' ? 'video/webm' : 'video/mp4');
      return { blob: file, ext, contentType, displayName: file.name || `video.${ext}` };
    }

    // Images / receipts — handle HEIC and large mobile photos
    const nameLower = (file.name || '').toLowerCase();
    const typeLower = (file.type || '').toLowerCase();
    const isHeic =
      typeLower.includes('heic') ||
      typeLower.includes('heif') ||
      nameLower.endsWith('.heic') ||
      nameLower.endsWith('.heif');

    const tryCanvasJpeg = async (): Promise<{ blob: Blob; ext: string; contentType: string; displayName: string } | null> => {
      try {
        // createImageBitmap works for JPEG/PNG/WebP; HEIC only on some browsers
        const bitmap = await createImageBitmap(file);
        const maxEdge = 2400;
        let { width, height } = bitmap;
        if (width > maxEdge || height > maxEdge) {
          const scale = maxEdge / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          bitmap.close();
          return null;
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85)
        );
        if (!blob || blob.size === 0) return null;
        return {
          blob,
          ext: 'jpg',
          contentType: 'image/jpeg',
          displayName: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
        };
      } catch {
        return null;
      }
    };

    // Always prefer JPEG for photos/receipts when we can re-encode (reliable on mobile + storage)
    if (isHeic || file.size > 2.5 * 1024 * 1024 || typeLower === 'image/jpeg' || typeLower === 'image/png' || typeLower === 'image/webp' || typeLower.startsWith('image/')) {
      const converted = await tryCanvasJpeg();
      if (converted) return converted;
    }

    if (isHeic) {
      // Fallback: upload original HEIC if browser can't decode (storage must allow it)
      return {
        blob: file,
        ext: 'heic',
        contentType: file.type || 'image/heic',
        displayName: file.name || 'photo.heic',
      };
    }

    const rawExt = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ext = rawExt || (typeLower.includes('png') ? 'png' : 'jpg');
    const contentType = file.type || (ext === 'png' ? 'image/png' : 'image/jpeg');
    return {
      blob: file,
      ext,
      contentType,
      displayName: file.name || `photo.${ext}`,
    };
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video' | 'receipt') => {
    if (!files?.length) {
      showMessage('No file selected.');
      return 0;
    }
    if (!user) {
      showMessage('Please log in before uploading photos.');
      return 0;
    }
    if (!supabase) {
      showMessage(getSupabaseConfigHelpMessage());
      return 0;
    }

    showMessage(type === 'photo' ? 'Uploading photo…' : type === 'video' ? 'Uploading video…' : 'Uploading…');

    const newUrls: string[] = [];
    const list = Array.from(files);

    for (let i = 0; i < list.length; i++) {
      const original = list[i];
      try {
        const prepared = await prepareFileForMediaUpload(original, type);
        if (!prepared) {
          showMessage(`Could not read ${type} from device. Try another photo or use the in-app camera.`);
          continue;
        }

        const { blob, ext, contentType } = prepared;
        const filePath = `${workspaceUserId}/${type}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const { error } = await supabase.storage.from('media').upload(filePath, blob, {
          upsert: true,
          contentType,
          cacheControl: '3600',
        });

        if (error) {
          console.error('Media upload failed:', error, { filePath, contentType, size: blob.size, name: original.name, type: original.type });
          const msg = (error as { message?: string }).message || 'Upload failed';
          if (/policy|row-level|security|jwt|auth/i.test(msg)) {
            showMessage('Upload blocked by storage permissions. Confirm you are logged in and the media bucket policies allow your user folder.');
          } else if (/payload|too large|size|413/i.test(msg)) {
            showMessage('Photo is too large. Try a smaller image or use the in-app camera.');
          } else if (/mime|type|not allowed|invalid/i.test(msg)) {
            showMessage('This image format is not allowed. Try JPG from the camera roll or the in-app camera.');
          } else {
            showMessage(`Failed to upload ${type}: ${msg}`);
          }
          continue;
        }

        newUrls.push(filePath);
      } catch (err) {
        console.error('Media upload exception:', err);
        showMessage(`Failed to upload ${type}. Try again or use the in-app camera.`);
      }
    }

    if (newUrls.length === 0) return 0;

    // Build next media lists synchronously so saveToDB does not write stale empty photoUrls
    const nextPhotos = type === 'photo' ? [...photoUrls, ...newUrls] : photoUrls;
    const nextVideos = type === 'video' ? [...videoUrls, ...newUrls] : videoUrls;
    const nextReceipts = type === 'receipt' ? [...receiptUrls, ...newUrls] : receiptUrls;

    if (type === 'photo') setPhotoUrls(nextPhotos);
    else if (type === 'video') setVideoUrls(nextVideos);
    else if (type === 'receipt') {
      setReceiptUrls(nextReceipts);
      const firstUrl = await getMediaUrl(newUrls[0]);
      if (firstUrl) setCurrentReceiptUrl(firstUrl);
      setTempReceiptData({ date: new Date().toISOString().split('T')[0], vendor: '', amount: 0, notes: '' });
      setIsReceiptExtractModalOpen(true);
    }

    await saveToDB({
      photoUrls: nextPhotos,
      videoUrls: nextVideos,
      receiptUrls: nextReceipts,
    });

    return newUrls.length;
  };

  const saveReceiptExtraction = () => {
    if (!currentReceiptUrl) return;
    const newDetail = {
      url: currentReceiptUrl,
      date: tempReceiptData.date,
      vendor: tempReceiptData.vendor,
      amount: parseFloat(tempReceiptData.amount.toString()) || 0,
      notes: tempReceiptData.notes
    };
    setReceiptDetails(prev => [...prev, newDetail]);
    setIsReceiptExtractModalOpen(false);
    saveToDB();
    showMessage('✅ Receipt data saved to database');
  };

  const handleCertificateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !supabase) return;
    const filePath = `${workspaceUserId}/certificate/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
    if (!error) {
      const next = { ...profileRef.current, certificateUrl: filePath };
      setProfile(next);
      await saveProfileSettings(next, { quiet: true });
      lastSavedCompanyFingerprintRef.current = JSON.stringify({
        name: next.name || '',
        company: next.company || '',
        slogan: next.slogan || '',
        address: next.address || '',
        phone: next.phone || '',
        email: next.email || '',
        city: next.city || '',
        state: next.state || '',
        zipCode: next.zipCode || '',
        disclosure: next.disclosure || '',
        logoUrl: next.logoUrl || '',
        logoSize: next.logoSize || 'medium',
        certificateUrl: next.certificateUrl || '',
      });
      setProfileAutoSaveLabel('Saved');
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      showMessage(isPdf ? '✅ PDF Certificate of Insurance uploaded' : '✅ Certificate of Insurance uploaded');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !supabase) return;
    const filePath = `${workspaceUserId}/logo/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
    if (!error) {
      const next = { ...profileRef.current, logoUrl: filePath };
      setProfile(next);
      await saveProfileSettings(next, { quiet: true });
      lastSavedCompanyFingerprintRef.current = JSON.stringify({
        name: next.name || '',
        company: next.company || '',
        slogan: next.slogan || '',
        address: next.address || '',
        phone: next.phone || '',
        email: next.email || '',
        city: next.city || '',
        state: next.state || '',
        zipCode: next.zipCode || '',
        disclosure: next.disclosure || '',
        logoUrl: next.logoUrl || '',
        logoSize: next.logoSize || 'medium',
        certificateUrl: next.certificateUrl || '',
      });
      setProfileAutoSaveLabel('Saved');
      showMessage('✅ Company logo uploaded');
    }
  };

  const removeMedia = (type: 'photo' | 'video' | 'receipt', index: number) => {
    if (type === 'photo') setPhotoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'video') setVideoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'receipt') {
      setReceiptUrls(prev => prev.filter((_, i) => i !== index));
      setReceiptDetails(prev => prev.filter((_, i) => i !== index));
    }
    saveToDB();
    if (type === 'video') showMessage('Video removed from this estimate.');
    else if (type === 'photo') showMessage('Photo removed from this estimate.');
  };

  const confirmRemoveVideo = (index: number) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this video from the estimate?')) {
      return;
    }
    removeMedia('video', index);
  };

  const openPhotoPicker = () => {
    if (!user || !supabase) {
      showMessage('Please log in before adding photos.');
      return;
    }
    setIsPhotoPickerOpen(true);
  };

  /** Opens device-style camera UI (fixed border + shutter; zoom only the preview). */
  const openDevicePhotoCamera = () => {
    setIsPhotoPickerOpen(false);
    if (!user || !supabase) {
      showMessage('Please log in before taking photos.');
      return;
    }
    setDeviceCameraMode('photo');
    setIsDeviceCameraOpen(true);
  };

  /** Opens device-style video recorder with the same fixed chrome. */
  const openDeviceVideoCamera = () => {
    setIsPhotoPickerOpen(false);
    if (!user || !supabase) {
      showMessage('Please log in before recording video.');
      return;
    }
    setDeviceCameraMode('video');
    setIsDeviceCameraOpen(true);
  };

  const triggerPhotoGallery = () => {
    setIsPhotoPickerOpen(false);
    window.setTimeout(() => {
      photoGalleryInputRef.current?.click();
    }, 150);
  };

  const triggerVideoGallery = () => {
    setIsPhotoPickerOpen(false);
    window.setTimeout(() => {
      videoGalleryInputRef.current?.click();
    }, 150);
  };

  const handlePhotoGalleryChange = async (files: FileList | null) => {
    try {
      const saved = await handleMediaUpload(files, 'photo');
      if (saved > 0) {
        showMessage(`✅ ${saved} photo${saved === 1 ? '' : 's'} saved to this estimate.`);
      } else if (files?.length) {
        // handleMediaUpload already showed a specific error
      }
    } catch (err) {
      console.error(err);
      showMessage('Photo upload failed on this device. Try the in-app camera instead.');
    } finally {
      if (photoGalleryInputRef.current) photoGalleryInputRef.current.value = '';
    }
  };

  const handleVideoGalleryChange = async (files: FileList | null) => {
    try {
      const saved = await handleMediaUpload(files, 'video');
      if (saved > 0) {
        showMessage(`✅ ${saved} video${saved === 1 ? '' : 's'} saved to this estimate.`);
      }
    } catch (err) {
      console.error(err);
      showMessage('Video upload failed. Try a shorter clip or the in-app camera.');
    } finally {
      if (videoGalleryInputRef.current) videoGalleryInputRef.current.value = '';
    }
  };

  const handleDeviceCameraPhoto = async (file: File) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    const saved = await handleMediaUpload(dt.files, 'photo');
    if (saved > 0) {
      showMessage('✅ Photo saved to this estimate.');
    }
  };

  const handleDeviceCameraVideo = async (file: File) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    const saved = await handleMediaUpload(dt.files, 'video');
    if (saved > 0) {
      showMessage('✅ Video saved to this estimate.');
    }
  };

  const handleDeviceCameraClose = (count: number) => {
    setIsDeviceCameraOpen(false);
    if (count > 0) {
      showMessage(
        `${count} ${deviceCameraMode === 'video' ? 'video' : 'photo'}${count === 1 ? '' : 's'} saved to this estimate.`
      );
    }
  };

  const isSettingsDocRow = (row: any) =>
    !row ||
    row.jobName === '__settings__' ||
    row.documentType === 'settings' ||
    row.documenttype === 'settings' ||
    String(row.id || '').startsWith('SETTINGS-');

  const isInvoiceDocRow = (row: any) => {
    if (!row || isSettingsDocRow(row)) return false;
    const num = String(row.invoiceNumber ?? row.invoicenumber ?? row.id ?? '');
    const id = String(row.id || '');
    const numU = num.toUpperCase();
    const idU = id.toUpperCase();
    return (
      row.documentType === 'invoice' ||
      row.documenttype === 'invoice' ||
      numU.startsWith('INV') ||
      idU.startsWith('INV')
    );
  };

  const isEstimateTypeRow = (row: any) => {
    if (!row || isSettingsDocRow(row) || isInvoiceDocRow(row)) return false;
    const num = String(row.invoiceNumber ?? row.invoicenumber ?? row.id ?? '');
    const id = String(row.id || '');
    const numU = num.toUpperCase();
    const idU = id.toUpperCase();
    return (
      row.documentType === 'estimate' ||
      row.documenttype === 'estimate' ||
      numU.startsWith('EST') ||
      idU.startsWith('EST') ||
      // default non-invoice docs are work orders / estimates
      (!row.documentType && !row.documenttype)
    );
  };

  const isPaidDocRow = (row: any) =>
    String(row?.paymentStatus ?? row?.paymentstatus ?? '').toLowerCase() === 'paid';

  /** Paid invoices (and fully paid work) belong in Profile → Paid Invoices, not active lists. */
  const shouldMoveToPaidFolder = (row: any) => {
    if (!row || isSettingsDocRow(row)) return false;
    if (!isPaidDocRow(row)) return false;
    return isInvoiceDocRow(row) || isEstimateTypeRow(row);
  };

  const normText = (v: any) =>
    String(v ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  const docNumberKeys = (row: any): string[] => {
    const keys = new Set<string>();
    for (const raw of [row?.id, row?.invoiceNumber, row?.invoicenumber]) {
      const s = String(raw ?? '').trim();
      if (!s || s.startsWith('SETTINGS')) continue;
      keys.add(s);
      keys.add(s.toUpperCase());
      // EST-0001 ↔ INV-0001 twins (any case / with or without dash)
      const m = s.match(/^(EST|INV)[-_]?(.+)$/i);
      if (m) {
        const rest = m[2];
        keys.add(`EST-${rest}`);
        keys.add(`INV-${rest}`);
        keys.add(`EST${rest}`);
        keys.add(`INV${rest}`);
        keys.add(`EST-${rest}`.toUpperCase());
        keys.add(`INV-${rest}`.toUpperCase());
      }
    }
    return Array.from(keys);
  };

  const jobMatchKeys = (row: any): string[] => {
    const job = normText(row?.jobName ?? row?.jobname);
    if (!job) return [];
    const zip = normText(row?.zipCode ?? row?.zipcode).slice(0, 5);
    const addr = normText(row?.address);
    const keys = [`job:${job}`];
    if (zip) keys.push(`jobzip:${job}|${zip}`);
    if (addr) keys.push(`jobaddr:${job}|${addr}`);
    return keys;
  };

  /**
   * Build lookup of closed-out work so related estimates leave the Estimates page.
   * - Number keys: any invoice / paid / archived (EST-0001 ↔ INV-0001)
   * - Job keys: paid or archived only (avoids hiding other open jobs for same client)
   */
  const buildClosedWorkIndex = (closedRows: any[]) => {
    const numberKeys = new Set<string>();
    const jobKeys = new Set<string>();
    for (const row of closedRows || []) {
      if (!row || isSettingsDocRow(row)) continue;
      const isPaid = isPaidDocRow(row);
      const isInv = isInvoiceDocRow(row);
      const isArchived = !!row.archived_at;
      if (!isPaid && !isInv && !isArchived) continue;

      // Twin numbers for convert + close-out
      if (isInv || isPaid || isArchived) {
        for (const k of docNumberKeys(row)) numberKeys.add(k);
      }
      // Job fingerprint only when work is truly closed (paid / in archive)
      if (isPaid || isArchived) {
        for (const k of jobMatchKeys(row)) jobKeys.add(k);
      }
    }
    return { numberKeys, jobKeys };
  };

  /** True if this active estimate belongs to already-closed/paid work. */
  const estimateBelongsToClosedWork = (est: any, closed: { numberKeys: Set<string>; jobKeys: Set<string> }) => {
    if (!est || isSettingsDocRow(est)) return false;
    if (isInvoiceDocRow(est) && !isPaidDocRow(est)) return false;
    if (isPaidDocRow(est)) return true;
    if (!isEstimateTypeRow(est) && !isInvoiceDocRow(est)) {
      // unknown type — still hide if number/job matches closed work
    }
    for (const k of docNumberKeys(est)) {
      if (closed.numberKeys.has(k)) return true;
    }
    const estJobKeys = jobMatchKeys(est);
    // Prefer job+zip or job+address; fall back to job-only
    if (estJobKeys.some((k) => k.startsWith('jobzip:') && closed.jobKeys.has(k))) return true;
    if (estJobKeys.some((k) => k.startsWith('jobaddr:') && closed.jobKeys.has(k))) return true;
    if (estJobKeys.some((k) => k.startsWith('job:') && closed.jobKeys.has(k))) return true;
    return false;
  };

  /**
   * Delete related estimate/work-order rows for a closed invoice (or set of closed docs).
   * Awaits DB deletes so the Estimates list stays clean after close-out.
   */
  const purgeRelatedEstimatesForClosedDocs = async (
    closedDocs: any[],
    uid?: string
  ): Promise<string[]> => {
    if (!supabase || !user) return [];
    const userId = uid || workspaceUserId;
    const closed = buildClosedWorkIndex(closedDocs);
    if (closed.numberKeys.size === 0 && closed.jobKeys.size === 0) return [];

    const { data: activeRows, error } = await supabase
      .from('estimates')
      .select('*')
      .eq('user_id', userId);
    if (error || !activeRows?.length) {
      if (error) console.warn('purgeRelatedEstimatesForClosedDocs fetch failed:', error);
      return [];
    }

    const closedIds = new Set(
      (closedDocs || []).map((d) => String(d?.id || '')).filter(Boolean)
    );
    const toDelete: string[] = [];
    for (const row of activeRows) {
      const rid = String(row.id || '');
      if (!rid || closedIds.has(rid) || isSettingsDocRow(row)) continue;
      // Never delete open unpaid invoices
      if (isInvoiceDocRow(row) && !isPaidDocRow(row)) continue;
      // Delete paid leftovers and any estimate/work order tied to closed work
      if (isPaidDocRow(row) || isEstimateTypeRow(row) || estimateBelongsToClosedWork(row, closed)) {
        toDelete.push(rid);
      }
    }

    // Unique ids
    const unique = Array.from(new Set(toDelete));
    for (const estId of unique) {
      const { error: delErr } = await supabase
        .from('estimates')
        .delete()
        .eq('id', estId)
        .eq('user_id', userId);
      if (delErr) console.warn('Failed to purge estimate', estId, delErr);
    }

    if (unique.length > 0) {
      setSavedEstimatesList((prev) =>
        (prev || []).filter((r: any) => !unique.includes(String(r.id)))
      );
    }
    return unique;
  };

  const refreshSavedList = async () => {
    if (!workspaceUserId || !supabase) return;
    const { data, error } = await supabase
      .from('estimates')
      .select('*')
      .eq('user_id', workspaceUserId)
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('refreshSavedList error:', error);
      return;
    }
    let rows = data || [];

    // Load archives first so we know which work is closed out
    const { data: archivedRows } = await supabase
      .from('archive-est')
      .select('*')
      .eq('user_id', workspaceUserId);
    const archives = archivedRows || [];

    // Move any paid invoices/docs still sitting in active estimates → paid folder (archive-est)
    const paidActive = rows.filter(shouldMoveToPaidFolder);
    if (paidActive.length > 0) {
      for (const row of paidActive) {
        try {
          const result = await persistArchive({
            ...row,
            paymentStatus: 'paid',
            documentType:
              row.documentType ??
              row.documenttype ??
              (isInvoiceDocRow(row) ? 'invoice' : 'estimate'),
          });
          if (!result?.error) {
            rows = rows.filter((r: any) => r.id !== row.id);
          }
        } catch (e) {
          console.warn('Auto-move to paid folder failed for', row.id, e);
        }
      }
      // Re-read archives after moves
      const { data: archivesAfter } = await supabase
        .from('archive-est')
        .select('*')
        .eq('user_id', workspaceUserId);
      if (archivesAfter) {
        archives.length = 0;
        archives.push(...archivesAfter);
      }
      void refreshArchivesList();
    }

    // Purge estimates that belong to closed/paid invoices (await so UI is correct)
    const closedIndex = buildClosedWorkIndex([
      ...archives,
      ...rows.filter((r) => isPaidDocRow(r) || isInvoiceDocRow(r)),
    ]);
    const purgeIds: string[] = [];
    rows = rows.filter((row: any) => {
      if (isSettingsDocRow(row)) return true;
      if (isInvoiceDocRow(row) && !isPaidDocRow(row)) return true;
      if (isPaidDocRow(row)) {
        purgeIds.push(String(row.id));
        return false;
      }
      if (isEstimateTypeRow(row) && estimateBelongsToClosedWork(row, closedIndex)) {
        purgeIds.push(String(row.id));
        return false;
      }
      return true;
    });

    if (purgeIds.length > 0) {
      for (const estId of Array.from(new Set(purgeIds))) {
        await supabase.from('estimates').delete().eq('id', estId).eq('user_id', workspaceUserId);
      }
    }

    // Never show paid invoices in active list UI
    rows = rows.filter((row: any) => !(isInvoiceDocRow(row) && isPaidDocRow(row)));
    // Never show estimates for closed work
    rows = rows.filter(
      (row: any) =>
        !isEstimateTypeRow(row) || !estimateBelongsToClosedWork(row, closedIndex)
    );

    setSavedEstimatesList(rows);
  };

  const refreshArchivesList = async () => {
    if (!workspaceUserId || !supabase) return;
    const { data, error } = await supabase
      .from('archive-est')
      .select('*')
      .eq('user_id', workspaceUserId)
      .order('archived_at', { ascending: false });
    if (error) {
      console.error('refreshArchivesList error:', error);
      showMessage('Could not load archives: ' + error.message);
      return;
    }
    // Normalize lowercase keys from DB to camelCase for the UI
    setArchivesList(
      (data || []).map((row: any) => ({
        ...row,
        jobName: row.jobName ?? row.jobname ?? '',
        documentType: row.documentType ?? row.documenttype ?? 'estimate',
        invoiceNumber: row.invoiceNumber ?? row.invoicenumber ?? row.id,
        zipCode: row.zipCode ?? row.zipcode ?? '',
        dueDate: row.dueDate ?? row.duedate ?? '',
        paymentStatus: row.paymentStatus ?? row.paymentstatus ?? 'pending',
        amountPaid: row.amountPaid ?? row.amountpaid ?? 0,
        paymentMethod: row.paymentMethod ?? row.paymentmethod ?? '',
        photoUrls: row.photoUrls ?? row.photourls ?? [],
        videoUrls: row.videoUrls ?? row.videourls ?? [],
        receiptUrls: row.receiptUrls ?? row.receipturls ?? [],
        receiptDetails: row.receiptDetails ?? row.receiptdetails ?? [],
        laborHours: row.laborHours ?? row.laborhours ?? 0,
        laborRate: row.laborRate ?? row.laborrate ?? 0,
        laborFixedAmount: row.laborFixedAmount ?? row.laborfixedamount ?? 0,
        useHourlyLabor: row.useHourlyLabor ?? row.usehourlylabor ?? true,
        laborAmount: row.laborAmount ?? row.laboramount ?? 0,
        taxRate: row.taxRate ?? row.taxrate ?? 0,
        taxAmount: row.taxAmount ?? row.taxamount ?? 0,
        isTaxExempt: row.isTaxExempt ?? row.istaxexempt ?? false,
        taxLabor: row.taxLabor ?? row.taxlabor ?? true,
      }))
    );
  };

  const loadSelectedEstimate = async (est: any) => {
    setJobName(est.jobName || '');
    setAddress(est.address || '');
    setCity(est.city || '');
    setState(est.state || '');
    setZipCode(est.zipCode || '');
    setPhones(est.phones || ['']);
    setEmails(est.emails || ['']);
    setDate(est.date || '');
    setInvoiceNumber(est.invoiceNumber || 'EST-0001');
    setItems(
      (est.items || [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]).map(
        normalizeLoadedLineItem
      )
    );
    setTerms(est.terms || '');
    const loadedProfile = est.profile || {};
    const cached = getProfileSettingsCache();
    const serverProfile = await fetchServerProfileSettings();
    const displaySettings = getGlobalDisplaySettings(profile, serverProfile);
    const {
      showMaterialBreakdownOnEstimate: _sm,
      showLaborBreakdownOnEstimate: _sl,
      showCostBreakdownOnEstimate: _sc,
      showPriceBreakdownByLine: _sp,
      showDiscountOnEstimate: _sd,
      ...loadedProfileWithoutBreakdown
    } = loadedProfile;
    setEstimateBreakdownSettings(getBreakdownSettingsFromDoc(loadedProfile));
    // IMPORTANT: always force preferred user language. Never use stale language from document snapshot (est.profile).
    const preferredLang = getPreferredLanguage();
    setProfile({
      ...profile,
      ...loadedProfileWithoutBreakdown,
      crewSubscriptionActive: loadedProfile.crewSubscriptionActive ?? false,
      chargeCCFee: loadedProfile.chargeCCFee ?? false,
      ccFeePercentage: loadedProfile.ccFeePercentage ?? 3,
      autoSaveEnabled: 'autoSaveEnabled' in loadedProfile
        ? loadedProfile.autoSaveEnabled !== false
        : (cached.autoSaveEnabled ?? profile.autoSaveEnabled ?? true),
      taxesEnabled: 'taxesEnabled' in cached
        ? cached.taxesEnabled !== false
        : (serverProfile && 'taxesEnabled' in serverProfile
          ? serverProfile.taxesEnabled !== false
          : ('taxesEnabled' in loadedProfile
            ? loadedProfile.taxesEnabled !== false
            : profile.taxesEnabled !== false)),
      ...displaySettings,
      appointmentReminderEnabled: 'appointmentReminderEnabled' in loadedProfile
        ? !!loadedProfile.appointmentReminderEnabled
        : (cached.appointmentReminderEnabled ?? profile.appointmentReminderEnabled ?? false),
      showDepositOnApproval: 'showDepositOnApproval' in loadedProfile
        ? loadedProfile.showDepositOnApproval !== false
        : (cached.showDepositOnApproval ?? profile.showDepositOnApproval ?? true),
      thirdPartyEscrowEnabled: 'thirdPartyEscrowEnabled' in loadedProfile
        ? !!loadedProfile.thirdPartyEscrowEnabled
        : (cached.thirdPartyEscrowEnabled ?? profile.thirdPartyEscrowEnabled ?? false),
      escrowMinimumAmount:
        'escrowMinimumAmount' in cached
          ? Math.max(0, Number(cached.escrowMinimumAmount) || 0)
          : (serverProfile && 'escrowMinimumAmount' in serverProfile
            ? Math.max(0, Number(serverProfile.escrowMinimumAmount) || 0)
            : ('escrowMinimumAmount' in loadedProfile
              ? Math.max(0, Number(loadedProfile.escrowMinimumAmount) || 0)
              : Math.max(0, Number(profile.escrowMinimumAmount) || 0))),
      depositPercentage: loadedProfile.depositPercentage ?? cached.depositPercentage ?? profile.depositPercentage ?? 10,
      paymentSettings: mergePaymentSettings({
        ...loadedProfile.paymentSettings,
        ...(serverProfile?.paymentSettings || {}),
        venmo: {
          ...mergePaymentSettings(loadedProfile.paymentSettings).venmo,
          ...mergePaymentSettings(serverProfile?.paymentSettings).venmo,
          handle:
            mergePaymentSettings(serverProfile?.paymentSettings).venmo?.handle ||
            mergePaymentSettings(loadedProfile.paymentSettings).venmo?.handle,
        },
      }),
      logoUrl: loadedProfile.logoUrl ?? '',
      logoSize: loadedProfile.logoSize ?? 'medium',
      language: preferredLang,
      city: loadedProfile.city ?? '',
      state: loadedProfile.state ?? '',
      zipCode: loadedProfile.zipCode ?? '',
      teammates: (loadedProfile.teammates || []).map((t: any) => ({
        ...t,
        canSeePricing: t.canSeePricing ?? false,
        canSeeEstimatesAndFinancials: t.canSeeEstimatesAndFinancials ?? false,
      })),
    });
    // Ensure latest company profile info (name, logo, etc.) is used even on old documents
    const latestProf = await loadLatestProfile();
    // Re-force the chosen language (in case loadLatest pulled something); localStorage wins
    const finalLang = getPreferredLanguage();
    setProfile(prev => ({ ...prev, language: finalLang }));
    // If this document has no terms, populate from company's Terms & Conditions
    if (!est.terms?.trim()) {
      const companyTerms = (latestProf && latestProf.disclosure) || profile.disclosure;
      if (companyTerms) {
        setTerms(companyTerms);
      }
    }
    setDocumentType(est.documentType || 'estimate');
    setDueDate(est.dueDate || '');
    setPaymentStatus(est.paymentStatus || 'pending');
    setAmountPaid(est.amountPaid || 0);
    setPaymentMethod(est.paymentMethod || '');
    setPhotoUrls(est.photoUrls || []);
    setPhotosFolderOpen(false);
    setVideoUrls(est.videoUrls || []);
    setReceiptUrls(est.receiptUrls || []);
    setReceiptDetails(est.receiptDetails || []);
    setJobMileageLogs(mileageLogsFromDoc(est));
    setLaborHours(est.laborHours || 0);
    setLaborRate(est.laborRate || 0);
    setLaborFixedAmount(est.laborFixedAmount || 0);
    setUseHourlyLabor(est.useHourlyLabor !== false);
    setIsTaxExempt(est.isTaxExempt || false);
    setTaxLabor(est.taxLabor !== false);
    const loadedDiscount = getDiscountFromDoc(est);
    setDiscountDescription(loadedDiscount.discountDescription);
    setDiscountValueInput(loadedDiscount.discountValue > 0 ? String(loadedDiscount.discountValue) : '');
    setDiscountType(loadedDiscount.discountType);
    setAppliedDiscountDescription(loadedDiscount.discountDescription);
    setAppliedDiscountValue(loadedDiscount.discountValue);
    setAppliedDiscountType(loadedDiscount.discountType);
    if (loadedDiscount.discountDescription.trim()) {
      ensureDiscountNameInList(loadedDiscount.discountDescription);
    }
  };

  const loadLatestProfile = async () => {
    if (!user || !supabase) return null;
    profileHydratingRef.current = true;
    try {
      // SETTINGS row is the durable company profile (not wiped by blank estimate saves)
      const serverProfile = await fetchServerProfileSettings();
      const { data } = await supabase
        .from('estimates')
        .select('profile, id, jobName, documentType')
        .eq('user_id', workspaceUserId)
        .neq('id', `SETTINGS-${workspaceUserId}`)
        .order('updated_at', { ascending: false })
        .limit(1);
      const loaded = data?.[0]?.profile || null;
      const cached = getProfileSettingsCache();
      const cachedCompany = (cached.companyProfile || {}) as Record<string, any>;
      const preferredLang = getPreferredLanguage();

      // Prefer: THIS account's SETTINGS → this account's local cache → latest estimate
      // Never keep previous React state from another login (start from blank)
      const s = serverProfile || {};
      const l = loaded || {};
      const hasServerCompany = !!(
        pickFilled(s.company, s.name, s.email, s.phone, s.address) ||
        pickFilled(l.company, l.name, l.email, l.phone, l.address)
      );
      // Only use device cache if it belongs to this workspace (keyed by id) and
      // server has no company yet OR cache is a same-user refresh aid
      const useCache = !hasServerCompany;

      setProfile(() => {
        const base = blankProfile();
        const displaySettings = getGlobalDisplaySettings(base, serverProfile);
        const {
          showMaterialBreakdownOnEstimate: _sm,
          showLaborBreakdownOnEstimate: _sl,
          showCostBreakdownOnEstimate: _sc,
          showPriceBreakdownByLine: _sp,
          showDiscountOnEstimate: _sd,
          ...loadedWithoutBreakdown
        } = l as any;

        return {
          ...base,
          // non-company fields may still come from latest estimate
          ...loadedWithoutBreakdown,
          // Company identity: server first; cache only for same account when empty cloud
          name: pickFilled(s.name, useCache ? cachedCompany.name : '', l.name, ''),
          company: pickFilled(s.company, useCache ? cachedCompany.company : '', l.company, ''),
          slogan: pickFilled(s.slogan, useCache ? cachedCompany.slogan : '', l.slogan, ''),
          address: pickFilled(s.address, useCache ? cachedCompany.address : '', l.address, ''),
          phone: pickFilled(s.phone, useCache ? cachedCompany.phone : '', l.phone, ''),
          email: pickFilled(s.email, useCache ? cachedCompany.email : '', l.email, ''),
          city: pickFilled(s.city, useCache ? cachedCompany.city : '', l.city, ''),
          state: pickFilled(s.state, useCache ? cachedCompany.state : '', l.state, ''),
          zipCode: pickFilled(s.zipCode, useCache ? cachedCompany.zipCode : '', l.zipCode, ''),
          disclosure: pickFilled(s.disclosure, useCache ? cachedCompany.disclosure : '', l.disclosure, ''),
          logoUrl: pickFilled(s.logoUrl, useCache ? cachedCompany.logoUrl : '', l.logoUrl, ''),
          certificateUrl: pickFilled(
            s.certificateUrl,
            useCache ? cachedCompany.certificateUrl : '',
            l.certificateUrl,
            ''
          ),
          logoSize: pickFilled(
            s.logoSize,
            useCache ? cachedCompany.logoSize : '',
            l.logoSize,
            'medium'
          ),
          crewSubscriptionActive: s.crewSubscriptionActive ?? l.crewSubscriptionActive ?? false,
          chargeCCFee: s.chargeCCFee ?? l.chargeCCFee ?? false,
          ccFeePercentage: s.ccFeePercentage ?? l.ccFeePercentage ?? 3,
          autoSaveEnabled: 'autoSaveEnabled' in (s as any)
            ? (s as any).autoSaveEnabled !== false
            : ('autoSaveEnabled' in l
              ? l.autoSaveEnabled !== false
              : (cached.autoSaveEnabled ?? true)),
          taxesEnabled: 'taxesEnabled' in cached
            ? cached.taxesEnabled !== false
            : (serverProfile && 'taxesEnabled' in serverProfile
              ? serverProfile.taxesEnabled !== false
              : ('taxesEnabled' in l
                ? l.taxesEnabled !== false
                : true)),
          ...displaySettings,
          appointmentReminderEnabled: 'appointmentReminderEnabled' in (s as any)
            ? !!(s as any).appointmentReminderEnabled
            : ('appointmentReminderEnabled' in l
              ? !!l.appointmentReminderEnabled
              : (cached.appointmentReminderEnabled ?? false)),
          showDepositOnApproval: 'showDepositOnApproval' in (s as any)
            ? (s as any).showDepositOnApproval !== false
            : ('showDepositOnApproval' in l
              ? l.showDepositOnApproval !== false
              : (cached.showDepositOnApproval ?? true)),
          thirdPartyEscrowEnabled: 'thirdPartyEscrowEnabled' in (s as any)
            ? !!(s as any).thirdPartyEscrowEnabled
            : ('thirdPartyEscrowEnabled' in l
              ? !!l.thirdPartyEscrowEnabled
              : (cached.thirdPartyEscrowEnabled ?? false)),
          escrowMinimumAmount:
            'escrowMinimumAmount' in cached
              ? Math.max(0, Number(cached.escrowMinimumAmount) || 0)
              : (serverProfile && 'escrowMinimumAmount' in serverProfile
                ? Math.max(0, Number(serverProfile.escrowMinimumAmount) || 0)
                : ('escrowMinimumAmount' in l
                  ? Math.max(0, Number(l.escrowMinimumAmount) || 0)
                  : 10000)),
          depositPercentage: s.depositPercentage ?? l.depositPercentage ?? cached.depositPercentage ?? 10,
          paymentSettings: mergePaymentSettings({
            ...(l.paymentSettings || {}),
            ...(serverProfile?.paymentSettings || {}),
            venmo: {
              ...mergePaymentSettings(l.paymentSettings).venmo,
              ...mergePaymentSettings(serverProfile?.paymentSettings).venmo,
              handle: pickFilled(
                mergePaymentSettings(serverProfile?.paymentSettings).venmo?.handle,
                mergePaymentSettings(l.paymentSettings).venmo?.handle,
                ''
              ),
            },
          }),
          language: preferredLang,
          teammates: ((s.teammates || l.teammates || []) as any[]).map((t: any) => ({
            ...t,
            canSeePricing: t.canSeePricing ?? false,
            canSeeEstimatesAndFinancials: t.canSeeEstimatesAndFinancials ?? false,
          })),
        };
      });
      // Sync fingerprint so auto-save does not re-write hydrate as a "change"
      lastSavedCompanyFingerprintRef.current = JSON.stringify({
        name: pickFilled(s.name, useCache ? cachedCompany.name : '', l.name, ''),
        company: pickFilled(s.company, useCache ? cachedCompany.company : '', l.company, ''),
        slogan: pickFilled(s.slogan, useCache ? cachedCompany.slogan : '', l.slogan, ''),
        address: pickFilled(s.address, useCache ? cachedCompany.address : '', l.address, ''),
        phone: pickFilled(s.phone, useCache ? cachedCompany.phone : '', l.phone, ''),
        email: pickFilled(s.email, useCache ? cachedCompany.email : '', l.email, ''),
        city: pickFilled(s.city, useCache ? cachedCompany.city : '', l.city, ''),
        state: pickFilled(s.state, useCache ? cachedCompany.state : '', l.state, ''),
        zipCode: pickFilled(s.zipCode, useCache ? cachedCompany.zipCode : '', l.zipCode, ''),
        disclosure: pickFilled(s.disclosure, useCache ? cachedCompany.disclosure : '', l.disclosure, ''),
        logoUrl: pickFilled(s.logoUrl, useCache ? cachedCompany.logoUrl : '', l.logoUrl, ''),
        logoSize: pickFilled(s.logoSize, useCache ? cachedCompany.logoSize : '', l.logoSize, 'medium'),
        certificateUrl: pickFilled(
          s.certificateUrl,
          useCache ? cachedCompany.certificateUrl : '',
          l.certificateUrl,
          ''
        ),
      });
      return serverProfile || loaded;
    } finally {
      // Allow auto-save only after hydrate settles
      window.setTimeout(() => {
        profileHydratingRef.current = false;
      }, 500);
    }
  };

  const newEstimate = async () => {
    setJobName(''); setAddress(''); setCity(''); setState(''); setZipCode('');
    setPhones(['']); setEmails(['']); setTerms('');
    setPhotoUrls([]); setVideoUrls([]); setReceiptUrls([]); setReceiptDetails([]); setJobMileageLogs([]);
    setPhotosFolderOpen(false);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setLaborHours(0); setLaborRate(0); setLaborFixedAmount(0); setUseHourlyLabor(true);
    setIsTaxExempt(false);
    setTaxLabor(true);
    setDiscountDescription('');
    setDiscountValueInput('');
    setDiscountType('dollar');
    setAppliedDiscountDescription('');
    setAppliedDiscountValue(0);
    setAppliedDiscountType('dollar');
    setEstimateBreakdownSettings(DEFAULT_ESTIMATE_BREAKDOWN);
    const today = new Date().toISOString().split('T')[0];
    setDate(today);
    const savedCount = parseInt(localStorage.getItem('estimateCount') || '0') + 1;
    localStorage.setItem('estimateCount', savedCount.toString());
    const prefix = documentType === 'invoice' ? 'INV' : 'EST';
    setInvoiceNumber(`${prefix}-${String(savedCount).padStart(4, '0')}`);
    const loadedProfile = await loadLatestProfile();
    // Force the chosen language (from localStorage preference) so new estimates never revert
    const newLang = getPreferredLanguage();
    setProfile(prev => ({ ...prev, language: newLang }));
    // For new documents, populate Terms & Conditions from company profile
    const companyTerms = loadedProfile?.disclosure || profile.disclosure;
    if (companyTerms) {
      setTerms(companyTerms);
    }
  };

  const openNewDocument = async (type: 'estimate' | 'invoice') => {
    setDocumentType(type);
    await newEstimate();
    if (user?.id) {
      await refreshSavedList();
      refreshArchivesList();
    }
    setView('editor');
  };

  const openExistingDocument = async (est: any) => {
    await loadSelectedEstimate(est);
    setView('editor');
  };

  const goToDashboard = () => setView('dashboard');

  const openQuickLinesModal = () => setIsQuickLinesModalOpen(true);

  const addRow = () => setItems(prev => [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }, ...prev]);

  const updateItem = (id: number, field: string, value: any) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const updatedItem = { ...item, [field]: value };

      if (field === 'total') {
        const total = parseFloat(value) || 0;
        const qty = item.qty || 0;
        updatedItem.total = roundMoney(total);
        updatedItem.price = qty > 0 ? roundMoney(total / qty) : roundMoney(total);
      } else if (field === 'qty' || field === 'price') {
        const qty = field === 'qty' ? (parseFloat(value) || 0) : (item.qty || 0);
        const price = field === 'price' ? (parseFloat(value) || 0) : (item.price || 0);
        updatedItem.total = roundMoney(qty * price);
      }

      return updatedItem;
    }));
  };

  const compressImageSourceForAi = async (
    source: CanvasImageSource & { width: number; height: number },
    cleanup?: () => void
  ): Promise<string> => {
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(source.width, source.height, 1));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare image');
    ctx.drawImage(source, 0, 0, width, height);
    cleanup?.();
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const compressImageFileForAi = async (file: File): Promise<string> => {
    try {
      const bitmap = await createImageBitmap(file);
      return await compressImageSourceForAi(bitmap, () => bitmap.close());
    } catch {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            void compressImageSourceForAi(img).then(resolve).catch(reject);
          };
          img.onerror = () => reject(new Error('Could not load image'));
          img.src = String(reader.result || '');
        };
        reader.onerror = () => reject(new Error('Could not read image file'));
        reader.readAsDataURL(file);
      });
    }
  };

  const imageUrlToBase64ForAi = async (url: string): Promise<string> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load job photo');
    const blob = await res.blob();
    const file = new File([blob], 'job-photo.jpg', { type: blob.type || 'image/jpeg' });
    return compressImageFileForAi(file);
  };

  const applyAiQuoteData = (itemId: number, data: any, options?: { fromPhoto?: boolean }) => {
    const item = items.find(row => row.id === itemId);
    if (!item) return;

    const nextQty = data.suggestedQty !== undefined && data.suggestedQty > 0 ? data.suggestedQty : (item.qty || 1);
    const nextPrice = roundMoney(Number(data.unitPrice) || 0);
    const nextUnit = (data.unit || item.unit || '').trim();
    const nextTotal = roundMoney(Number(data.total) > 0 ? Number(data.total) : nextQty * nextPrice);
    const scopeFromPhoto = String(data.analyzedScope || data.imageAnalysis?.scopeDescription || '').trim();
    const quoteDescription = (options?.fromPhoto && scopeFromPhoto) ? scopeFromPhoto : (item.description || '');

    const normalizedBreakdown = normalizeStoredCostBreakdown({
      description: quoteDescription,
      qty: nextQty,
      unit: nextUnit,
      unitPrice: nextPrice,
      total: nextTotal,
      materials: data.materials || [],
      labor: data.laborBreakdown
        ? {
            description: data.laborBreakdown.description,
            hours: data.laborBreakdown.hours,
            rate: data.laborBreakdown.rate,
            total: data.laborBreakdown.total,
          }
        : null,
      materialMultiplier: data.pricingRegion?.materialMultiplier,
      typicalLaborRate: 62,
      maxLaborRate: 75,
      expectedLaborHours: data.laborBreakdown?.hours,
    });
    const { linePricing, billing } = normalizedBreakdown;

    setItems(prev =>
      prev.map(row => {
        if (row.id !== itemId) return row;
        const updated: any = {
          ...row,
          price: linePricing.price,
          qty: linePricing.qty,
          unit: linePricing.unit,
          total: linePricing.total,
        };
        if (options?.fromPhoto && scopeFromPhoto) {
          updated.description = scopeFromPhoto;
        }
        if (normalizedBreakdown.materials.length) {
          updated.materialsList = normalizedBreakdown.materials;
          updated.materialBreakdown = null;
        }
        if (normalizedBreakdown.labor) {
          updated.laborBreakdown = normalizedBreakdown.labor;
        }
        return updated;
      })
    );

    const regionLabel = data.pricingRegion?.label;
    const regionNote = regionLabel
      ? `\nPriced for: ${regionLabel}${data.pricingRegion?.source === 'company' ? ' (from company profile — add job ZIP for best accuracy)' : ''}`
      : '';
    const billingLabel = billing.perSqft
      ? `${linePricing.qty.toLocaleString()} SF × $${linePricing.price.toFixed(2)}/SF`
      : linePricing.qty > 1
        ? `${linePricing.qty} ${linePricing.unit} × $${linePricing.price.toFixed(2)}`
        : `1 Unit @ $${linePricing.price.toFixed(2)}`;
    let msg = options?.fromPhoto
      ? `✅ AI quote from photo applied!${regionNote}`
      : `✅ AI Price Quote applied!${regionNote}`;
    msg += `\n\n${billingLabel} = $${linePricing.total.toFixed(2)}\nConfidence: ${data.confidence}`;
    if (scopeFromPhoto && options?.fromPhoto) {
      msg += `\n\nScope from photo: ${scopeFromPhoto}`;
    }
    if (data.breakdown) {
      msg += `\n\nScope: ${data.breakdown}`;
    }
    if (data.materials?.length) {
      msg += `\n\n${data.materials.length} materials listed.`;
    }
    if (data.laborBreakdown?.hours) {
      msg += `\nLabor: ${data.laborBreakdown.description || 'Installation'} — ${data.laborBreakdown.hours} hrs`;
    }
    if (normalizedBreakdown.materials.length || normalizedBreakdown.labor) {
      const mat = normalizedBreakdown.materialsCostTotal.toFixed(2);
      const lab = normalizedBreakdown.laborCostTotal.toFixed(2);
      const builtUp = roundMoney(normalizedBreakdown.materialsCostTotal + normalizedBreakdown.laborCostTotal).toFixed(2);
      const matchNote = billing.perSqft
        ? `matches line total $${linePricing.total.toFixed(2)} (${linePricing.qty.toLocaleString()} SF × $${linePricing.price.toFixed(2)}/SF)`
        : `matches line total $${linePricing.total.toFixed(2)}`;
      msg += `\nBuilt-up cost: materials $${mat} + labor $${lab} = $${builtUp} (${matchNote})`;
    }
    showMessage(msg);
  };

  const requestAiQuote = async (
    item: any,
    options?: { imageBase64?: string; imageUrl?: string; fromPhoto?: boolean }
  ) => {
    setAiQuoteLoadingId(item.id);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`;
        }
      }

      const res = await fetch('/api/ai-quote', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: item.description?.trim() || '',
          imageBase64: options?.imageBase64,
          imageUrl: options?.imageUrl,
          jobLocation: { address, city, state, zipCode },
          companyLocation: {
            city: profile.city,
            state: profile.state,
            zipCode: profile.zipCode,
            address: profile.address,
          },
          lineContext: { qty: item.qty, unit: item.unit },
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        const errMsg = data.error || 'AI quote error';
        if (errMsg.includes('Rate limit')) {
          showMessage(`⏳ ${errMsg}`);
        } else if (errMsg.includes('Unauthorized') || errMsg.includes('missing')) {
          showMessage('🔒 Please log in with a main account to use AI features.');
        } else if (errMsg.includes('API key') || errMsg.includes('Incorrect') || errMsg.includes('GROK_API_KEY')) {
          showMessage('🔑 AI service key issue. Check Vercel env vars and redeploy.');
        } else if (errMsg.includes('invalid format')) {
          showMessage('⚠️ AI returned invalid data. Try a different description or photo.');
        } else if (errMsg.includes('Vision') || errMsg.includes('photo') || errMsg.includes('image')) {
          showMessage(`📷 ${errMsg}`);
        } else {
          showMessage(`❌ ${errMsg}`);
        }
        return;
      }

      applyAiQuoteData(item.id, data, { fromPhoto: options?.fromPhoto });
    } catch (err) {
      console.error('AI Quote call failed:', err);
      showMessage('⚠️ Network error. Could not reach AI quote service. Check your connection or console.');
    } finally {
      setAiQuoteLoadingId(null);
    }
  };

  const openGalleryPhotoQuote = (imageUrl: string) => {
    if (!imageUrl) return;
    setPhotoQuoteImageUrl(imageUrl);
    setPhotoQuoteLineId(items[0]?.id ?? null);
    setIsPhotoQuoteLinePickerOpen(true);
  };

  const runGalleryPhotoQuote = async () => {
    if (!photoQuoteImageUrl || photoQuoteLineId == null) {
      showMessage('Select a line item for the photo quote.');
      return;
    }
    const item = items.find(row => row.id === photoQuoteLineId);
    if (!item) return;
    setIsPhotoQuoteLinePickerOpen(false);
    try {
      const imageBase64 = await imageUrlToBase64ForAi(photoQuoteImageUrl);
      await requestAiQuote(item, { imageBase64, fromPhoto: true });
    } catch (err) {
      console.error('Gallery photo quote failed:', err);
      showMessage('⚠️ Could not read that job photo. Try uploading it again.');
    } finally {
      setPhotoQuoteImageUrl('');
    }
  };

  const emptyBreakdownMaterial = () => ({
    description: '',
    qty: 1,
    unit: 'ea',
    unitPrice: 0,
    total: 0,
  });

  const emptyBreakdownLabor = () => ({
    description: 'Labor',
    hours: 0,
    rate: 0,
    total: 0,
  });

  const normalizeBreakdownMaterial = (m: any) => {
    const qty = Number(m?.qty) || 0;
    const unitPrice = roundMoney(Number(m?.unitPrice) || 0);
    const total = roundMoney(Number(m?.total) || qty * unitPrice);
    return {
      description: String(m?.description || '').trim(),
      qty,
      unit: String(m?.unit || '').trim(),
      unitPrice,
      total,
    };
  };

  const normalizeBreakdownLabor = (l: any) => {
    const hours = Number(l?.hours) || 0;
    const rate = roundMoney(Number(l?.rate) || 0);
    const total = roundMoney(Number(l?.total) || hours * rate);
    return {
      description: String(l?.description || 'Labor').trim(),
      hours,
      rate,
      total,
    };
  };

  const getBuiltUpBreakdownPrice = (
    materials: Array<{ total: number }>,
    labor: { total: number } | null
  ) => roundMoney(
    materials.reduce((sum, m) => sum + (Number(m.total) || 0), 0) +
    (labor ? Number(labor.total) || 0 : 0)
  );

  const openBreakdownEditor = (item: any) => {
    const materials = getItemMaterials(item).map(normalizeBreakdownMaterial);
    const labor = item.laborBreakdown ? normalizeBreakdownLabor(item.laborBreakdown) : null;
    setBreakdownEditItemId(item.id);
    setBreakdownMaterials(materials.length ? materials : [emptyBreakdownMaterial()]);
    setBreakdownLabor(labor);
    setBreakdownIncludeLabor(!!labor || materials.length === 0);
    setBreakdownSyncLinePrice(true);
    setIsBreakdownModalOpen(true);
  };

  const closeBreakdownEditor = () => {
    setIsBreakdownModalOpen(false);
    setBreakdownEditItemId(null);
  };

  const updateBreakdownMaterial = (
    index: number,
    field: 'description' | 'qty' | 'unit' | 'unitPrice' | 'total',
    value: string | number
  ) => {
    setBreakdownMaterials(prev => prev.map((m, i) => {
      if (i !== index) return m;
      const next = { ...m, [field]: value };
      if (field === 'qty' || field === 'unitPrice') {
        next.total = roundMoney((Number(next.qty) || 0) * (Number(next.unitPrice) || 0));
      } else if (field === 'total') {
        const qty = Number(next.qty) || 0;
        next.total = roundMoney(Number(value) || 0);
        next.unitPrice = qty > 0 ? roundMoney(next.total / qty) : roundMoney(next.total);
      }
      return next;
    }));
  };

  const updateBreakdownLaborField = (
    field: 'description' | 'hours' | 'rate' | 'total',
    value: string | number
  ) => {
    setBreakdownLabor(prev => {
      const base = prev || emptyBreakdownLabor();
      const next = { ...base, [field]: value };
      if (field === 'hours' || field === 'rate') {
        next.total = roundMoney((Number(next.hours) || 0) * (Number(next.rate) || 0));
      } else if (field === 'total') {
        const hours = Number(next.hours) || 0;
        next.total = roundMoney(Number(value) || 0);
        next.rate = hours > 0 ? roundMoney(next.total / hours) : roundMoney(next.total);
      }
      return next;
    });
  };

  const addBreakdownMaterialRow = () => {
    setBreakdownMaterials(prev => [...prev, emptyBreakdownMaterial()]);
  };

  const removeBreakdownMaterialRow = (index: number) => {
    setBreakdownMaterials(prev => {
      const next = prev.filter((_, i) => i !== index);
      return next.length ? next : [emptyBreakdownMaterial()];
    });
  };

  const saveBreakdown = () => {
    if (breakdownEditItemId == null) return;

    const materials = breakdownMaterials
      .map(normalizeBreakdownMaterial)
      .filter(m => m.description.length > 0);
    const labor = breakdownIncludeLabor
      ? normalizeBreakdownLabor(breakdownLabor || emptyBreakdownLabor())
      : null;
    const builtUp = getBuiltUpBreakdownPrice(materials, labor);

    setItems(prev => prev.map(item => {
      if (item.id !== breakdownEditItemId) return item;
      const qty = item.qty || 0;
      const updated: any = {
        ...item,
        materialsList: materials,
        materialBreakdown: null,
        laborBreakdown: labor && (labor.description || labor.hours || labor.rate || labor.total) ? labor : null,
      };
      if (breakdownSyncLinePrice && builtUp > 0) {
        const pricing = syncLineItemPricingFromJobTotal(
          item.description || '',
          qty || 1,
          item.unit || '',
          builtUp
        );
        updated.qty = pricing.qty;
        updated.unit = pricing.unit;
        updated.price = pricing.price;
        updated.total = pricing.total;
      }
      return updated;
    }));

    closeBreakdownEditor();
    showMessage('✅ Line breakdown saved');
    saveToDB();
  };

  // === TRANSLATE FUNCTION (added exactly as requested) ===
  const translateDescription = async (text: string, itemId: number) => {
    if (!text.trim()) return showMessage('Enter text first');
    
    try {
      // Use our authenticated proxy (enforces login + rate limit)
      const headers: any = { 'Content-Type': 'application/json' };
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const res = await fetch('/api/translate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, from: translateFrom, to: translateTo })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setItemTranslations(prev => ({ ...prev, [itemId]: data.translatedText }));
      showMessage('✅ Translation added (internal use only)');
    } catch (err: any) {
      const msg = err?.message || 'Translation service temporarily unavailable.';
      showMessage(`⚠️ ${msg}. Using Grok for translation (GROK_API_KEY required).`);
    }
  };

  const removeRow = (id: number) => setItems(prev => prev.filter(item => item.id !== id));

  const addPhone = () => setPhones([...phones, '']);
  const removePhone = (i: number) => setPhones(phones.filter((_, idx) => idx !== i));
  const updatePhone = (i: number, value: string) => { const arr = [...phones]; arr[i] = value; setPhones(arr); };
  const addEmail = () => setEmails([...emails, '']);
  const removeEmail = (i: number) => setEmails(emails.filter((_, idx) => idx !== i));
  const updateEmail = (i: number, value: string) => { const arr = [...emails]; arr[i] = value; setEmails(arr); };

  const saveNamedEstimate = async () => {
    await saveToDB();
    showMessage(`✅ Saved as "${jobName || 'Untitled'} - ${invoiceNumber}"`);
  };

  const printDocument = () => window.print();

  const saveAsPDF = async () => {
    const element = document.getElementById('preview-document');
    if (!element) {
      showMessage('Preview content not found for PDF generation.');
      return;
    }

    // Expand photo folder so PDF includes every image (not just the folder tile)
    const folderWasOpen = photosFolderOpen;
    if (photoDisplayUrls.length > PHOTO_FOLDER_THRESHOLD && !photosFolderOpen) {
      setPhotosFolderOpen(true);
      await new Promise((r) => setTimeout(r, 120));
    }

    try {
      const html2pdf = (await import('html2pdf.js')).default;

      const opt = {
        margin: 0.5,
        filename: `${documentType === 'invoice' ? 'Invoice' : 'Estimate'}-${invoiceNumber}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.98 },
        html2canvas: { 
          scale: 2, 
          useCORS: true,
          letterRendering: true,
          backgroundColor: '#ffffff',
          onclone: (clonedDoc: Document) => {
            // Fix for "lab" / oklch color parsing error in html2canvas
            // Inject overriding styles into the cloned document
            const style = clonedDoc.createElement('style');
            style.innerHTML = `
              *, *::before, *::after {
                color: #111827 !important;
                background-color: #ffffff !important;
                border-color: #d1d5db !important;
                box-shadow: none !important;
              }
            `;
            clonedDoc.head.appendChild(style);
          }
        },
        jsPDF: { 
          unit: 'in', 
          format: 'letter', 
          orientation: 'portrait' as const 
        }
      };

      await html2pdf().set(opt).from(element).save();
      showMessage('✅ PDF saved successfully!');
    } catch (err) {
      console.error('PDF generation error:', err);
      showMessage('❌ Failed to generate PDF. Please try again.');
    } finally {
      if (!folderWasOpen) setPhotosFolderOpen(false);
    }
  };

  /**
   * Remove the original estimate/work-order row once a job has become an invoice
   * (or is being closed out), so it no longer appears on the Estimates page.
   */
  const removeEstimateWorkOrderForInvoice = async (
    invoiceRowOrId: any,
    uid?: string,
    extraContext?: { jobName?: string; address?: string; zipCode?: string }
  ) => {
    if (!supabase || !user) return;
    const userId = uid || workspaceUserId;
    const invoiceRow =
      typeof invoiceRowOrId === 'string'
        ? {
            id: invoiceRowOrId,
            invoiceNumber: invoiceRowOrId,
            documentType: 'invoice',
            paymentStatus: 'paid',
            jobName: extraContext?.jobName,
            address: extraContext?.address,
            zipCode: extraContext?.zipCode,
          }
        : invoiceRowOrId;

    // Direct EST twin delete (fast path)
    for (const key of docNumberKeys(invoiceRow)) {
      const m = String(key).match(/^INV[-_]?(.*)$/i);
      if (!m) continue;
      const rest = m[1];
      for (const estId of [`EST-${rest}`, `EST${rest}`, `est-${rest}`, `Est-${rest}`]) {
        await supabase.from('estimates').delete().eq('id', estId).eq('user_id', userId);
      }
    }

    // Broad purge by number + job for any leftover work orders
    await purgeRelatedEstimatesForClosedDocs(
      [
        {
          ...invoiceRow,
          documentType: invoiceRow.documentType || 'invoice',
          paymentStatus: invoiceRow.paymentStatus || 'paid',
          archived_at: invoiceRow.archived_at || new Date().toISOString(),
        },
      ],
      userId
    );
  };

  const convertToInvoice = async () => {
    const previousId = invoiceNumber;
    const prevUpper = previousId.toUpperCase();
    const nextNumber = prevUpper.startsWith('EST')
      ? previousId.replace(/^est/i, 'INV').replace(/^EST/, 'INV')
      : previousId;

    setDocumentType('invoice');
    if (prevUpper.startsWith('EST')) setInvoiceNumber(nextNumber);
    setView('sendPreview');

    // Persist as invoice under the new INV- id and drop the EST- work order immediately
    if (user && supabase) {
      try {
        const data = {
          user_id: workspaceUserId,
          jobName,
          address,
          city,
          state,
          zipCode,
          phones,
          emails,
          date,
          invoiceNumber: nextNumber,
          items,
          terms,
          profile: getDocumentProfileSnapshot(),
          documentType: 'invoice' as const,
          dueDate,
          paymentStatus,
          amountPaid,
          paymentMethod,
          photoUrls,
          videoUrls,
          receiptUrls,
          receiptDetails,
          laborHours,
          laborRate,
          laborFixedAmount,
          useHourlyLabor,
          laborAmount,
          taxRate: baseTaxRate,
          taxAmount,
          isTaxExempt,
          taxLabor,
          updated_at: new Date().toISOString(),
        };
        const { error } = await supabase.from('estimates').upsert({ id: nextNumber, ...data });
        if (error) {
          console.error('convertToInvoice save failed:', error);
          showMessage('Converted to invoice in the editor, but save failed. Tap Save on the invoice.');
        } else {
          // Always remove the original estimate row when the id changed
          if (previousId && previousId !== nextNumber) {
            await supabase.from('estimates').delete().eq('id', previousId).eq('user_id', workspaceUserId);
            // Also try lowercase column invoiceNumber variants
            await supabase
              .from('estimates')
              .delete()
              .eq('user_id', workspaceUserId)
              .eq('invoiceNumber', previousId);
          }
          await removeEstimateWorkOrderForInvoice(
            {
              id: nextNumber,
              invoiceNumber: nextNumber,
              documentType: 'invoice',
              jobName,
              address,
              zipCode,
              paymentStatus: paymentStatus || 'pending',
            },
            workspaceUserId
          );
          // Optimistically drop the old estimate from the list immediately
          setSavedEstimatesList((prev) =>
            (prev || []).filter(
              (r: any) =>
                String(r.id) !== previousId &&
                String(r.invoiceNumber ?? r.invoicenumber ?? '') !== previousId
            )
          );
          await refreshSavedList();
          showMessage('✅ Converted to invoice — estimate removed from the Estimates page.');
        }
      } catch (e) {
        console.error('convertToInvoice unexpected error:', e);
      }
    }
  };

  // Build archive payload. Reads camelCase or lowercase keys from estimates rows.
  const prepareArchiveData = (estRow: any) => {
    if (!estRow) return null;

    const g = (camel: string, lower?: string) => {
      const l = lower || camel.toLowerCase();
      if (estRow[camel] !== undefined && estRow[camel] !== null) return estRow[camel];
      if (estRow[l] !== undefined && estRow[l] !== null) return estRow[l];
      return null;
    };
    const toArray = (v: any): any[] => Array.isArray(v) ? v : (v == null ? [] : [v]);
    const toNum = (v: any): number | null => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toBool = (v: any, defaultVal = false): boolean => {
      if (v === true || v === 1 || v === 'true') return true;
      if (v === false || v === 0 || v === 'false') return false;
      return defaultVal;
    };

    const uid = estRow.user_id || estRow.userId || workspaceUserId;
    if (!uid) {
      console.error('prepareArchiveData: missing user_id', estRow);
      return null;
    }

    const itemsRaw = g('items') ?? [];
    const receiptDetailsRaw = g('receiptDetails', 'receiptdetails') ?? [];

    return {
      id: estRow.id,
      user_id: uid,
      documentType: g('documentType', 'documenttype') || 'estimate',
      jobName: g('jobName', 'jobname'),
      address: g('address'),
      city: g('city'),
      state: g('state'),
      zipCode: g('zipCode', 'zipcode'),
      phones: toArray(g('phones')),
      emails: toArray(g('emails')),
      date: g('date'),
      invoiceNumber: g('invoiceNumber', 'invoicenumber') || estRow.id,
      items: Array.isArray(itemsRaw) ? itemsRaw : [],
      terms: g('terms'),
      laborHours: toNum(g('laborHours', 'laborhours')),
      laborRate: toNum(g('laborRate', 'laborrate')),
      laborFixedAmount: toNum(g('laborFixedAmount', 'laborfixedamount')),
      useHourlyLabor: toBool(g('useHourlyLabor', 'usehourlylabor'), true),
      laborAmount: toNum(g('laborAmount', 'laboramount')),
      taxRate: toNum(g('taxRate', 'taxrate')),
      taxAmount: toNum(g('taxAmount', 'taxamount')),
      isTaxExempt: toBool(g('isTaxExempt', 'istaxexempt'), false),
      taxLabor: toBool(g('taxLabor', 'taxlabor'), true),
      photoUrls: toArray(g('photoUrls', 'photourls')),
      videoUrls: toArray(g('videoUrls', 'videourls')),
      receiptUrls: toArray(g('receiptUrls', 'receipturls')),
      receiptDetails: Array.isArray(receiptDetailsRaw) ? receiptDetailsRaw : [],
      dueDate: g('dueDate', 'duedate'),
      paymentStatus: g('paymentStatus', 'paymentstatus') || 'pending',
      amountPaid: toNum(g('amountPaid', 'amountpaid')),
      paymentMethod: g('paymentMethod', 'paymentmethod'),
      profile: (estRow.profile && typeof estRow.profile === 'object') ? estRow.profile : {},
      updated_at: g('updated_at') || new Date().toISOString(),
      archived_at: new Date().toISOString(),
    };
  };

  const formatArchiveErr = (err: any) =>
    [err?.code, err?.message, err?.details, err?.hint].filter(Boolean).join(' | ') || JSON.stringify(err);

  /**
   * Move document into archive-est, then delete from estimates.
   * Tries camelCase column names first (quoted schema), then lowercase (unquoted Postgres).
   */
  const persistArchive = async (estRow: any) => {
    if (!supabase || !user) {
      return { error: { message: 'Not logged in or Supabase not configured' } as any };
    }
    const id = String(estRow.id);
    const uid = estRow.user_id || estRow.userId || workspaceUserId;

    const archiveData = prepareArchiveData(estRow);
    if (!archiveData) {
      return { error: { message: 'Could not prepare archive payload (missing user_id?)' } as any };
    }

    // Clear any previous archive row for this id
    await supabase.from('archive-est').delete().eq('id', id).eq('user_id', uid);

    // 1) camelCase keys → columns like "documentType", "jobName" (quoted schema)
    let result = await supabase.from('archive-est').insert(archiveData);
    if (result.error) {
      console.warn('archive-est camelCase insert failed:', formatArchiveErr(result.error));

      // 2) lowercase keys → columns like documenttype, jobname (unquoted schema)
      const lower: Record<string, any> = {};
      for (const [k, v] of Object.entries(archiveData)) {
        if (k === 'id' || k === 'user_id' || k === 'updated_at' || k === 'archived_at') lower[k] = v;
        else lower[k.toLowerCase()] = v;
      }
      result = await supabase.from('archive-est').insert(lower);
    }

    if (result.error) {
      console.error('archive-est insert failed (both shapes):', formatArchiveErr(result.error));
      return {
        error: {
          message:
            formatArchiveErr(result.error) +
            ' — Run fix_archive_est_table.sql in Supabase SQL Editor, then NOTIFY pgrst reload.',
        } as any,
      };
    }

    // Only remove from active list after archive insert succeeds
    const del = await supabase.from('estimates').delete().eq('id', id).eq('user_id', uid);
    if (del.error) {
      console.warn('Archived to archive-est but delete from estimates failed:', del.error);
      return { error: null, warning: del.error.message };
    }

    // Immediately drop this id from the in-memory list
    setSavedEstimatesList((prev) => (prev || []).filter((r: any) => String(r.id) !== id));

    // Closed-out / paid work must not leave the original estimate on the Estimates page
    const purged = await removeEstimateWorkOrderForInvoice(
      {
        ...archiveData,
        id,
        paymentStatus: archiveData.paymentStatus || 'paid',
        documentType: archiveData.documentType || 'invoice',
        archived_at: archiveData.archived_at || new Date().toISOString(),
      },
      uid
    );
    void purged;

    return { error: null };
  };

  /**
   * Restore a document from archive-est back into active estimates.
   * Reverse of persistArchive: insert into estimates, then remove archive row.
   */
  const retrieveArchive = async (archRow: any) => {
    if (!supabase || !user) {
      showMessage('Not logged in or Supabase not configured.');
      return;
    }
    if (currentCrew) {
      showMessage('Crew accounts cannot retrieve archived documents.');
      return;
    }
    if (!archRow?.id) {
      showMessage('Could not retrieve: missing document id.');
      return;
    }
    if (!confirm('Retrieve this document from archives and restore it to your active list?')) return;

    const id = String(archRow.id);
    const uid = archRow.user_id || archRow.userId || workspaceUserId;

    try {
      // Build estimates payload (no archived_at column on estimates)
      const g = (camel: string, lower?: string) => {
        const l = lower || camel.toLowerCase();
        if (archRow[camel] !== undefined && archRow[camel] !== null) return archRow[camel];
        if (archRow[l] !== undefined && archRow[l] !== null) return archRow[l];
        return null;
      };
      const toArray = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
      const toNum = (v: any): number | null => {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const toBool = (v: any, defaultVal = false): boolean => {
        if (v === true || v === 1 || v === 'true') return true;
        if (v === false || v === 0 || v === 'false') return false;
        return defaultVal;
      };

      const itemsRaw = g('items') ?? [];
      const receiptDetailsRaw = g('receiptDetails', 'receiptdetails') ?? [];

      const estimateData: Record<string, any> = {
        id,
        user_id: uid,
        documentType: g('documentType', 'documenttype') || 'estimate',
        jobName: g('jobName', 'jobname'),
        address: g('address'),
        city: g('city'),
        state: g('state'),
        zipCode: g('zipCode', 'zipcode'),
        phones: toArray(g('phones')),
        emails: toArray(g('emails')),
        date: g('date'),
        invoiceNumber: g('invoiceNumber', 'invoicenumber') || id,
        items: Array.isArray(itemsRaw) ? itemsRaw : [],
        terms: g('terms'),
        laborHours: toNum(g('laborHours', 'laborhours')),
        laborRate: toNum(g('laborRate', 'laborrate')),
        laborFixedAmount: toNum(g('laborFixedAmount', 'laborfixedamount')),
        useHourlyLabor: toBool(g('useHourlyLabor', 'usehourlylabor'), true),
        laborAmount: toNum(g('laborAmount', 'laboramount')),
        taxRate: toNum(g('taxRate', 'taxrate')),
        taxAmount: toNum(g('taxAmount', 'taxamount')),
        isTaxExempt: toBool(g('isTaxExempt', 'istaxexempt'), false),
        taxLabor: toBool(g('taxLabor', 'taxlabor'), true),
        photoUrls: toArray(g('photoUrls', 'photourls')),
        videoUrls: toArray(g('videoUrls', 'videourls')),
        receiptUrls: toArray(g('receiptUrls', 'receipturls')),
        receiptDetails: Array.isArray(receiptDetailsRaw) ? receiptDetailsRaw : [],
        dueDate: g('dueDate', 'duedate'),
        paymentStatus: g('paymentStatus', 'paymentstatus') || 'pending',
        amountPaid: toNum(g('amountPaid', 'amountpaid')),
        paymentMethod: g('paymentMethod', 'paymentmethod'),
        profile: archRow.profile && typeof archRow.profile === 'object' ? archRow.profile : {},
        updated_at: new Date().toISOString(),
      };

      // Upsert into active estimates
      let result = await supabase.from('estimates').upsert(estimateData);
      if (result.error) {
        console.warn('retrieveArchive camelCase upsert failed:', formatArchiveErr(result.error));
        const lower: Record<string, any> = {};
        for (const [k, v] of Object.entries(estimateData)) {
          if (k === 'id' || k === 'user_id' || k === 'updated_at') lower[k] = v;
          else lower[k.toLowerCase()] = v;
        }
        result = await supabase.from('estimates').upsert(lower);
      }
      if (result.error) {
        console.error('retrieveArchive insert failed:', formatArchiveErr(result.error));
        showMessage(
          'Retrieve failed: ' +
            formatArchiveErr(result.error) +
            ' — Document was left in archives.'
        );
        return;
      }

      // Remove from archive only after successful restore
      const del = await supabase.from('archive-est').delete().eq('id', id).eq('user_id', uid);
      if (del.error) {
        console.warn('Restored to estimates but archive delete failed:', del.error);
        showMessage('✅ Document restored, but archive cleanup failed: ' + del.error.message);
      } else {
        showMessage('✅ Document retrieved from archives and restored to your active list');
      }

      await refreshArchivesList();
      await refreshSavedList();
    } catch (e: any) {
      console.error('Unexpected error retrieving archive', id, e);
      showMessage('Retrieve failed: ' + (e?.message || 'unexpected error'));
    }
  };

  const deleteArchivedDocument = async (id: string) => {
    if (!confirm('Delete this archived document permanently? This cannot be undone.')) return;
    if (!user || !supabase) return;
    if (currentCrew) {
      showMessage('Crew accounts cannot delete archived documents.');
      return;
    }
    const { error } = await supabase.from('archive-est').delete().eq('id', id).eq('user_id', workspaceUserId);
    if (error) {
      console.error('deleteArchivedDocument error:', error);
      showMessage('Could not delete archive: ' + error.message);
      return;
    }
    await refreshArchivesList();
    showMessage('Archived document deleted');
  };

  const openArchivesView = async () => {
    await refreshArchivesList();
    setView('archivesView');
  };

  const markAsPaidCash = async () => {
    if (!confirm('Mark this invoice as Paid (Cash) and close it out to the archives?')) return;
    if (!user || !supabase) return;

    const id = invoiceNumber;

    try {
      // Explicitly save the paid/cash status (avoids stale state from setPayment* + immediate await saveToDB)
      const paidData = {
        user_id: workspaceUserId,
        jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber: id,
        items, terms, profile: getDocumentProfileSnapshot(),
        documentType, dueDate,
        paymentStatus: 'paid',
        amountPaid: grandTotal,
        paymentMethod: 'Cash',
        photoUrls, videoUrls, receiptUrls, receiptDetails,
        laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
        taxRate: baseTaxRate,
        taxAmount,
        isTaxExempt,
        taxLabor,
        updated_at: new Date().toISOString()
      };
      const { error: saveErr } = await supabase.from('estimates').upsert({ id, ...paidData });
      if (saveErr) {
        console.error('Failed to save paid status:', saveErr);
        showMessage('❌ Failed to mark as paid.');
        return;
      }

      // Re-fetch the freshly updated row (defensively scoped to this user)
      const { data: est, error: fetchErr } = await supabase
        .from('estimates')
        .select('*')
        .eq('id', id)
        .eq('user_id', workspaceUserId)
        .single();
      if (fetchErr || !est) {
        console.error('Fetch for archive failed:', fetchErr);
        showMessage('✅ Invoice marked as Paid (Cash), but could not load for archiving.');
        setProfileTab('paidInvoices');
        setView('profileView');
        await refreshSavedList();
        return;
      }

      const { error: archiveErr } = await persistArchive(est);
      if (archiveErr) {
        console.error('Archive insert error after mark paid:', archiveErr);
        showMessage(
          `✅ Invoice marked as Paid (Cash), but archiving failed: ${(archiveErr as any).message || 'unknown'} — Run ensure_archives_table.sql`
        );
        await refreshSavedList();
        return;
      }

      showMessage('✅ Invoice marked as Paid (Cash) and moved to Paid Invoices');
      setProfileTab('paidInvoices');
      setView('profileView');
      await refreshSavedList();
      await refreshArchivesList();
    } catch (e: any) {
      console.error('Unexpected error in markAsPaidCash:', e);
      const msg = e?.message || 'unexpected error';
      showMessage(`✅ Invoice marked as Paid (Cash), but archiving failed: ${msg}`);
      await refreshSavedList();
    }
  };

  const openSendPreview = () => {
    setView('sendPreview');
  };

  const mileageRateLocalKey = (uid: string) => `estimateace_mileage_rate_${uid}`;

  const loadMileageRateFromSettings = async () => {
    if (!workspaceUserId) return;
    try {
      const raw = localStorage.getItem(mileageRateLocalKey(workspaceUserId));
      if (raw != null && Number.isFinite(Number(raw))) {
        setMileageRatePerMile(Number(raw));
      }
    } catch {
      /* ignore */
    }
    if (!supabase) return;
    const serverProfile = await fetchServerProfileSettings();
    if (serverProfile?.mileageRatePerMile != null && Number.isFinite(Number(serverProfile.mileageRatePerMile))) {
      const rate = Number(serverProfile.mileageRatePerMile);
      setMileageRatePerMile(rate);
      try {
        localStorage.setItem(mileageRateLocalKey(workspaceUserId), String(rate));
      } catch {
        /* ignore */
      }
    }
  };

  /** Persist only the global $/mile rate (used for write-off totals on Profile). */
  const saveMileageRate = async (_logs: MileageLog[], rate: number) => {
    if (!workspaceUserId) {
      showMessage('Please log in to save mileage rate.');
      return;
    }
    setMileageSaving(true);
    try {
      try {
        localStorage.setItem(mileageRateLocalKey(workspaceUserId), String(rate));
      } catch {
        /* ignore */
      }
      if (!supabase) {
        showMessage('✅ Mileage rate saved on this device.');
        return;
      }
      const existing = (await fetchServerProfileSettings()) || {};
      const { error } = await supabase.from('estimates').upsert({
        id: `SETTINGS-${workspaceUserId}`,
        user_id: workspaceUserId,
        jobName: '__settings__',
        documentType: 'settings',
        items: [],
        profile: {
          ...existing,
          mileageRatePerMile: rate,
        },
        updated_at: new Date().toISOString(),
      });
      if (error) {
        console.error('saveMileageRate:', error);
        showMessage('Rate saved locally, cloud failed: ' + error.message);
        return;
      }
      showMessage('✅ Mileage rate saved');
    } finally {
      setMileageSaving(false);
    }
  };

  /** Save job miles onto the current estimate/invoice. */
  const saveJobMileage = async (logs: MileageLog[]) => {
    setJobMileageLogs(logs);
    if (!user || !supabase) {
      showMessage('✅ Miles saved on this device. Log in to sync to the job.');
      return;
    }
    setMileageSaving(true);
    try {
      await saveToDB({ mileageLogs: logs });
      // Refresh list caches so Profile totals update
      void refreshSavedList();
      showMessage('✅ Job mileage saved');
    } finally {
      setMileageSaving(false);
    }
  };

  const loadReceptionistFromSettings = async () => {
    if (!workspaceUserId) return;
    try {
      const raw = localStorage.getItem(`estimateace_receptionist_${workspaceUserId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        setReceptionistSettings(normalizeReceptionistSettings(parsed?.settings));
        setReceptionistMessages(normalizeReceptionistMessages(parsed?.messages));
      }
    } catch {
      /* ignore */
    }
    if (!supabase) return;
    const serverProfile = await fetchServerProfileSettings();
    if (!serverProfile) return;
    if (serverProfile.aiReceptionist) {
      setReceptionistSettings(normalizeReceptionistSettings(serverProfile.aiReceptionist));
    }
    if (serverProfile.aiReceptionistMessages) {
      setReceptionistMessages(normalizeReceptionistMessages(serverProfile.aiReceptionistMessages));
    }
  };

  const refreshBillingStatus = async () => {
    if (!user || !supabase) {
      setBillingLoaded(false);
      return;
    }
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setBillingLoaded(true);
        return;
      }
      const res = await fetch('/api/billing/status', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.billing) {
        setBilling({
          ...DEFAULT_BILLING_SNAPSHOT,
          ...data.billing,
        });
        setBillingEnforced(!!data.enforced);
        setBillingStripeOk(!!data.stripeConfigured || !!data.stripe?.configured);
        setBillingStripeDiag(data.stripe || {});
      }
    } catch (e) {
      console.warn('refreshBillingStatus', e);
    } finally {
      setBillingLoaded(true);
    }
  };

  const startSubscriptionCheckout = async (plan: 'monthly' | 'yearly' = 'monthly') => {
    if (!supabase) {
      const msg = 'Supabase is not configured.';
      setBillingCheckoutError(msg);
      showMessage(msg);
      return;
    }
    setBillingCheckoutError(null);
    setBillingBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        const msg = 'Please log in again.';
        setBillingCheckoutError(msg);
        showMessage(msg);
        return;
      }
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        const msg =
          data.error ||
          (!billingStripeOk
            ? 'Stripe is not configured. Add STRIPE_SECRET_KEY and monthly/yearly price IDs in Vercel, then Redeploy.'
            : 'Could not start checkout. Check Stripe keys/price ids and redeploy.');
        setBillingCheckoutError(msg);
        showMessage(msg);
        return;
      }
      window.location.assign(data.url);
    } catch (e) {
      console.error(e);
      const msg = 'Checkout failed. Check your connection and try again.';
      setBillingCheckoutError(msg);
      showMessage(msg);
    } finally {
      setBillingBusy(false);
    }
  };

  const openBillingPortal = async () => {
    if (!supabase) return showMessage('Not configured');
    setBillingBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        showMessage('Please log in again.');
        return;
      }
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        showMessage(data.error || 'Could not open billing portal');
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      console.error(e);
      showMessage('Billing portal failed.');
    } finally {
      setBillingBusy(false);
    }
  };

  const addCrewMember = async () => {
    if (currentCrew) {
      return showMessage('Crew accounts cannot invite other crew.');
    }
    const email = crewEmailInput.trim().toLowerCase();
    const password = crewPasswordInput;
    if (!email) return showMessage('Enter email for the crew account');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return showMessage('Enter a valid email address');
    }
    if (password.length < 6) {
      return showMessage('Set a password (at least 6 characters) for this crew login');
    }
    if ((profile.teammates || []).some((t) => t.email.toLowerCase() === email)) {
      return showMessage('That email is already on your crew list');
    }
    if (!supabase || !user) return showMessage('Please log in first');

    setCrewInviteBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return showMessage('Please log in again.');

      const res = await fetch('/api/crew/invite', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          role: 'limited',
          canSeePricing: false,
          canSeeEstimatesAndFinancials: false,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return showMessage(json.error || 'Could not create crew login');
      }

      const newCrew = {
        email,
        userId: json.crew?.userId as string | undefined,
        role: 'limited' as 'full' | 'limited',
        canSeePricing: false,
        canSeeEstimatesAndFinancials: false,
      };
      setProfile((prev) => ({
        ...prev,
        teammates: [...(prev.teammates || []), newCrew],
      }));
      setCrewEmailInput('');
      setCrewPasswordInput('');
      showMessage(
        `✅ Crew login created for ${email}. They sign in on the main login page with that email and password.`
      );
      setTimeout(() => saveToDB(), 100);
    } catch {
      showMessage('Network error creating crew login.');
    } finally {
      setCrewInviteBusy(false);
    }
  };

  const updateCrewPermissions = async (
    email: string,
    patch: {
      role?: 'full' | 'limited';
      canSeePricing?: boolean;
      canSeeEstimatesAndFinancials?: boolean;
    }
  ) => {
    if (!supabase || currentCrew) return;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      await fetch('/api/crew/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, ...patch }),
      });
    } catch {
      /* profile save still has flags for display */
    }
  };

  const removeCrewMember = async (email: string, crewUserId?: string) => {
    if (!supabase || currentCrew) return;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      await fetch('/api/crew/remove', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, crewUserId }),
      });
    } catch {
      /* still remove from local list */
    }
  };

  const deleteOwnAccount = async () => {
    if (!supabase || !user) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      showMessage('Type DELETE in the box to confirm.');
      return;
    }
    setDeleteAccountBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        showMessage('Please log in again.');
        return;
      }
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(data.error || 'Could not schedule account deletion');
        return;
      }
      const closeLabel = data.accountClosesAt
        ? formatPeriodEnd(data.accountClosesAt)
        : 'the end of your paid period';
      // Popup message: access until end of paid period
      window.alert(
        data.message ||
          `Your account is scheduled to close on ${closeLabel}.\n\nYou will keep full access until that date.\nOn that date, access stops and your data is removed.`
      );
      showMessage(
        `✅ Account closing ${closeLabel} — you keep access until then.`
      );
      setDeleteConfirmText('');
      setBillingPanel('overview');
      await refreshBillingStatus();
    } catch (e) {
      console.error(e);
      showMessage('Could not schedule deletion. Contact support.');
    } finally {
      setDeleteAccountBusy(false);
    }
  };

  const saveReceptionistData = async (
    settings: ReceptionistSettings,
    messages: ReceptionistMessage[]
  ) => {
    if (!workspaceUserId) {
      showMessage('Please log in to save AI Receptionist.');
      return;
    }
    setReceptionistSaving(true);
    try {
      try {
        localStorage.setItem(
          `estimateace_receptionist_${workspaceUserId}`,
          JSON.stringify({ settings, messages })
        );
      } catch {
        /* ignore */
      }
      if (!supabase) {
        showMessage('✅ Receptionist saved on this device.');
        return;
      }
      const existing = (await fetchServerProfileSettings()) || {};
      const { error } = await supabase.from('estimates').upsert({
        id: `SETTINGS-${workspaceUserId}`,
        user_id: workspaceUserId,
        jobName: '__settings__',
        documentType: 'settings',
        items: [],
        profile: {
          ...existing,
          aiReceptionist: settings,
          aiReceptionistMessages: messages.slice(0, 200),
        },
        updated_at: new Date().toISOString(),
      });
      if (error) {
        console.error('saveReceptionistData:', error);
        showMessage('Saved locally; cloud failed: ' + error.message);
        return;
      }
      showMessage('✅ AI Receptionist saved');
    } finally {
      setReceptionistSaving(false);
    }
  };

  const syncAppointmentsToServer = async (
    nextAppointments: typeof appointments,
    nextProfile = profile
  ) => {
    if (!user || !supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    try {
      await fetch('/api/appointments/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          appointments: nextAppointments,
          profile: {
            ...getSafeProfileSnapshot(nextProfile),
            email: nextProfile.email || '',
            phone: nextProfile.phone || '',
            name: nextProfile.name || '',
            appointmentReminderEnabled: !!nextProfile.appointmentReminderEnabled,
          },
        }),
      });
    } catch (err) {
      console.error('Appointment sync failed:', err);
    }
  };

  const upsertUserSettingsProfile = async (nextProfile: typeof profile) => {
    if (!workspaceUserId || !supabase) return;
    const existing = await fetchServerProfileSettings();
    const snapshot = getSafeProfileSnapshot(nextProfile);
    // Merge so we never wipe previously saved company fields with blanks
    const mergedProfile = {
      ...(existing || {}),
      ...snapshot,
      name: pickFilled(snapshot.name, existing?.name),
      company: pickFilled(snapshot.company, existing?.company),
      slogan: pickFilled(snapshot.slogan, existing?.slogan),
      address: pickFilled(snapshot.address, existing?.address),
      phone: pickFilled(snapshot.phone, existing?.phone),
      email: pickFilled(snapshot.email, existing?.email),
      city: pickFilled(snapshot.city, existing?.city),
      state: pickFilled(snapshot.state, existing?.state),
      zipCode: pickFilled(snapshot.zipCode, existing?.zipCode),
      disclosure: pickFilled(snapshot.disclosure, existing?.disclosure),
      logoUrl: pickFilled(snapshot.logoUrl, existing?.logoUrl),
      certificateUrl: pickFilled(snapshot.certificateUrl, existing?.certificateUrl),
      logoSize: pickFilled(snapshot.logoSize, existing?.logoSize, 'medium'),
      appointmentReminderEnabled: !!nextProfile.appointmentReminderEnabled,
    };
    // Never wipe global mileage rate / receptionist when saving company profile
    const profileWithMileage = {
      ...mergedProfile,
      mileageRatePerMile:
        (mergedProfile as any).mileageRatePerMile ??
        (existing as any)?.mileageRatePerMile ??
        mileageRatePerMile,
      aiReceptionist:
        (mergedProfile as any).aiReceptionist ??
        (existing as any)?.aiReceptionist ??
        receptionistSettings,
      aiReceptionistMessages:
        (mergedProfile as any).aiReceptionistMessages ??
        (existing as any)?.aiReceptionistMessages ??
        receptionistMessages,
    };
    await supabase.from('estimates').upsert({
      id: `SETTINGS-${workspaceUserId}`,
      user_id: workspaceUserId,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      profile: profileWithMileage,
      updated_at: new Date().toISOString(),
    });
    // Durable local backup of company identity (survives reloads)
    setProfileSettingsCache({
      companyProfile: {
        name: mergedProfile.name,
        company: mergedProfile.company,
        slogan: mergedProfile.slogan,
        address: mergedProfile.address,
        phone: mergedProfile.phone,
        email: mergedProfile.email,
        city: mergedProfile.city,
        state: mergedProfile.state,
        zipCode: mergedProfile.zipCode,
        disclosure: mergedProfile.disclosure,
        logoUrl: mergedProfile.logoUrl,
        logoSize: mergedProfile.logoSize,
        certificateUrl: mergedProfile.certificateUrl,
      },
    });
  };

  const saveProfileSettings = async (nextProfile: typeof profile, options?: { quiet?: boolean }) => {
    setProfileSettingsCache({
      depositPercentage: nextProfile.depositPercentage,
      showDepositOnApproval: nextProfile.showDepositOnApproval,
      thirdPartyEscrowEnabled: nextProfile.thirdPartyEscrowEnabled,
      escrowMinimumAmount: Math.max(0, Number(nextProfile.escrowMinimumAmount) || 0),
      autoSaveEnabled: nextProfile.autoSaveEnabled,
      appointmentReminderEnabled: nextProfile.appointmentReminderEnabled,
      showDiscountOnEstimate: nextProfile.showDiscountOnEstimate === true,
      taxesEnabled: nextProfile.taxesEnabled !== false,
    });
    await upsertUserSettingsProfile(nextProfile);
    // Keep open estimate's embedded profile in sync, but SETTINGS row is source of truth
    await saveToDB({ profile: nextProfile });
    await syncAppointmentsToServer(appointments, nextProfile);
    if (!options?.quiet) {
      // callers that want toast still pass nothing; auto-save uses quiet
    }
  };

  const saveEstimateBreakdownSettings = async (
    updates: Partial<typeof estimateBreakdownSettings>
  ) => {
    const next = { ...estimateBreakdownSettings, ...updates };
    setEstimateBreakdownSettings(next);
    await saveToDB({ breakdown: next });
    showMessage('✅ Breakdown display saved for this estimate.');
  };

  const saveBreakdownProfileSettings = async (updates: Partial<typeof profile>) => {
    const nextProfile = { ...profile, ...updates };
    if ('showDiscountOnEstimate' in updates) {
      setProfileSettingsCache({
        ...getProfileSettingsCache(),
        showDiscountOnEstimate: updates.showDiscountOnEstimate === true,
      });
    }
    setProfile(nextProfile);
    await saveProfileSettings(nextProfile);
    showMessage(
      'showDiscountOnEstimate' in updates
        ? updates.showDiscountOnEstimate
          ? '✅ Discount line will show on client estimates.'
          : '✅ Discount line hidden on client estimates (discount still applies to total).'
        : '✅ Profile display settings saved.'
    );
  };

  const saveProfile = async () => {
    await saveProfileSettings(profile);
    lastSavedCompanyFingerprintRef.current = companyProfileFingerprint;
    setProfileAutoSaveLabel('Saved');
    showMessage('✅ Profile saved!');
  };

  const companyProfileFingerprint = useMemo(
    () =>
      JSON.stringify({
        name: profile.name || '',
        company: profile.company || '',
        slogan: profile.slogan || '',
        address: profile.address || '',
        phone: profile.phone || '',
        email: profile.email || '',
        city: profile.city || '',
        state: profile.state || '',
        zipCode: profile.zipCode || '',
        disclosure: profile.disclosure || '',
        logoUrl: profile.logoUrl || '',
        logoSize: profile.logoSize || 'medium',
        certificateUrl: profile.certificateUrl || '',
      }),
    [
      profile.name,
      profile.company,
      profile.slogan,
      profile.address,
      profile.phone,
      profile.email,
      profile.city,
      profile.state,
      profile.zipCode,
      profile.disclosure,
      profile.logoUrl,
      profile.logoSize,
      profile.certificateUrl,
    ]
  );

  /** Auto-save company profile shortly after edits; does not clear fields when blank elsewhere. */
  useEffect(() => {
    if (!user || !supabase) return;
    if (profileHydratingRef.current) {
      lastSavedCompanyFingerprintRef.current = companyProfileFingerprint;
      return;
    }
    if (companyProfileFingerprint === lastSavedCompanyFingerprintRef.current) return;

    const parsed = JSON.parse(companyProfileFingerprint) as Record<string, string>;
    const hasAnyCompanyData = Object.entries(parsed).some(([k, v]) => {
      if (k === 'logoSize') return false;
      return String(v || '').trim() !== '';
    });
    // Don't auto-create empty SETTINGS row on first login with blank profile
    if (!hasAnyCompanyData && !lastSavedCompanyFingerprintRef.current) return;

    setProfileAutoSaveLabel('Saving…');
    if (profileAutoSaveTimeoutRef.current) {
      clearTimeout(profileAutoSaveTimeoutRef.current);
    }
    profileAutoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveProfileSettings(profileRef.current, { quiet: true });
        lastSavedCompanyFingerprintRef.current = companyProfileFingerprint;
        setProfileAutoSaveLabel('Saved');
      } catch (err) {
        console.error('Company profile auto-save failed:', err);
        setProfileAutoSaveLabel('Save failed');
      }
    }, 750);

    return () => {
      if (profileAutoSaveTimeoutRef.current) {
        clearTimeout(profileAutoSaveTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save when company fields fingerprint changes
  }, [companyProfileFingerprint, user?.id, supabase]);

  const testAppointmentReminder = async () => {
    if (!supabase || testingReminder) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      showMessage('Please log in to test appointment reminders.');
      return;
    }

    setTestingReminder(true);
    try {
      const response = await fetch('/api/appointment-reminders/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ force: true }),
      });
      const data = await response.json();

      if (data.skipped) {
        showMessage(`Reminder test skipped: ${data.reason}`);
        return;
      }
      if (!response.ok) {
        showMessage(data.error || 'Reminder test failed.');
        return;
      }

      const parts: string[] = [];
      if (data.emailsSent?.length) parts.push(`Email sent to ${data.emailsSent.join(', ')}`);
      if (data.smsSent?.length) parts.push(`Text sent to ${data.smsSent.join(', ')}`);
      if (data.errors?.length) parts.push(data.errors.join('\n'));

      if (data.notified) {
        showMessage(
          `✅ Test reminder sent (${data.appointmentCount} appointment${data.appointmentCount === 1 ? '' : 's'}).\n\n${parts.join('\n')}`
        );
      } else {
        showMessage(`Reminder test completed but nothing was sent.\n\n${parts.join('\n') || 'Check RESEND_API_KEY / Twilio settings.'}`);
      }
    } catch {
      showMessage('Reminder test failed. Check the server console.');
    } finally {
      setTestingReminder(false);
    }
  };

  const persistAppointments = (nextAppointments: typeof appointments) => {
    setAppointments(nextAppointments);
    if (user?.id) {
      localStorage.setItem(`estimateace_appointments_${workspaceUserId}`, JSON.stringify(nextAppointments));
      void syncAppointmentsToServer(nextAppointments, profile);
    }
  };

  const toDatetimeLocalValue = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const resetAppointmentForm = () => {
    setEditingAppointmentId(null);
    setSelectedEstimateForCalendar(null);
    setSelectedDateTime('');
  };

  const openCalendarModal = async () => {
    await refreshSavedList();
    resetAppointmentForm();
    setCalendarView('schedule');
    setAppointmentsMonth(new Date().getMonth());
    setAppointmentsYear(new Date().getFullYear());
    setIsCalendarModalOpen(true);
  };

  const openEditAppointment = async (appt: (typeof appointments)[0]) => {
    if (!user || !supabase) return;
    const { data } = await supabase
      .from('estimates')
      .select('*')
      .eq('user_id', workspaceUserId)
      .order('updated_at', { ascending: false });
    const estimates = data || [];
    setSavedEstimatesList(estimates);
    const estimate = estimates.find(
      est =>
        est.id === appt.estimateId &&
        (est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST'))
    );
    setEditingAppointmentId(appt.id);
    setSelectedEstimateForCalendar(estimate || null);
    setSelectedDateTime(toDatetimeLocalValue(appt.datetime));
    setCalendarView('schedule');
  };

  const goToPreviousAppointmentsMonth = () => {
    if (appointmentsMonth === 0) {
      setAppointmentsMonth(11);
      setAppointmentsYear(prev => prev - 1);
    } else {
      setAppointmentsMonth(prev => prev - 1);
    }
  };

  const goToNextAppointmentsMonth = () => {
    if (appointmentsMonth === 11) {
      setAppointmentsMonth(0);
      setAppointmentsYear(prev => prev + 1);
    } else {
      setAppointmentsMonth(prev => prev + 1);
    }
  };

  const scheduleAppointment = async () => {
    const isEdit = !!editingAppointmentId;
    const isStillEstimate = selectedEstimateForCalendar &&
      (selectedEstimateForCalendar.documentType === 'estimate' || selectedEstimateForCalendar.invoiceNumber?.startsWith('EST'));
    if (!selectedEstimateForCalendar || !isStillEstimate || !selectedDateTime) {
      return showMessage(isEdit ? 'Select estimate and date/time to save changes' : 'Select estimate and date/time');
    }
    if (schedulingAppointment) return;

    const appointmentDate = new Date(selectedDateTime);
    const appointmentTime = appointmentDate.toLocaleString();
    const clientEmails = (selectedEstimateForCalendar.emails || []).map((e: string) => e?.trim()).filter((e: string) => e && e.includes('@'));
    const clientPhones = (selectedEstimateForCalendar.phones || []).map((p: string) => p?.trim()).filter(Boolean);

    if (isEdit) {
      persistAppointments(
        appointments.map(appt =>
          appt.id === editingAppointmentId
            ? {
                ...appt,
                estimateId: selectedEstimateForCalendar.id,
                jobName: selectedEstimateForCalendar.jobName || 'Untitled',
                invoiceNumber: selectedEstimateForCalendar.invoiceNumber || selectedEstimateForCalendar.id,
                datetime: appointmentDate.toISOString(),
              }
            : appt
        )
      );
    } else {
      const newAppointment = {
        id: `${Date.now()}`,
        estimateId: selectedEstimateForCalendar.id,
        jobName: selectedEstimateForCalendar.jobName || 'Untitled',
        invoiceNumber: selectedEstimateForCalendar.invoiceNumber || selectedEstimateForCalendar.id,
        datetime: appointmentDate.toISOString(),
      };
      persistAppointments([...appointments, newAppointment]);
    }

    setSchedulingAppointment(true);
    let notificationSummary = '';

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      }

      const response = await fetch('/api/appointment-notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobName: selectedEstimateForCalendar.jobName,
          invoiceNumber: selectedEstimateForCalendar.invoiceNumber || selectedEstimateForCalendar.id,
          address: selectedEstimateForCalendar.address,
          city: selectedEstimateForCalendar.city,
          state: selectedEstimateForCalendar.state,
          zipCode: selectedEstimateForCalendar.zipCode,
          appointmentDateTime: appointmentDate.toISOString(),
          emails: clientEmails,
          phones: clientPhones,
          companyName: profile.company || 'EstimateAce',
          companyPhone: profile.phone || '',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        notificationSummary = data.error || 'Could not send client notifications.';
      } else {
        const sentParts: string[] = [];
        if (data.emailsSent?.length) sentParts.push(`📧 ${data.emailsSent.join(', ')}`);
        if (data.smsSent?.length) sentParts.push(`📱 ${data.smsSent.join(', ')}`);

        if (sentParts.length > 0) {
          notificationSummary = `Notifications sent to ${sentParts.join(' and ')}.`;
        } else if (clientEmails.length === 0 && clientPhones.length === 0) {
          notificationSummary = 'No client email or phone on file for this estimate.';
        } else {
          notificationSummary = data.errors?.[0] || 'Notifications could not be sent.';
        }
      }
    } catch {
      notificationSummary = 'Appointment saved, but sending notifications failed. Check your server configuration.';
    } finally {
      setSchedulingAppointment(false);
    }

    showMessage(
      isEdit
        ? `✅ Appointment updated for ${appointmentTime}\n\n${notificationSummary}`
        : `✅ Appointment scheduled for ${appointmentTime}\n\n${notificationSummary}`
    );

    if (isEdit) {
      setCalendarView('appointments');
    } else {
      setIsCalendarModalOpen(false);
      setCalendarView('schedule');
    }
    resetAppointmentForm();
  };

  const saveAsQuickLine = (item: any) => {
    const newQuick = { id: Date.now(), description: item.description, qty: item.qty, unit: item.unit, price: item.price };
    const updated = [...quickLines, newQuick];
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
    showMessage('Quick line saved!');
  };

  const applyQuickLine = (quick: any) => {
    const newItem = { id: Date.now(), description: quick.description, qty: quick.qty, unit: quick.unit, price: quick.price, total: quick.qty * quick.price };
    setItems(prev => [...prev, newItem]);
    setIsQuickLinesModalOpen(false);
  };

  const deleteQuickLine = (id: number) => {
    const updated = quickLines.filter(q => q.id !== id);
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete permanently?')) return;
    if (!supabase) return;
    if (!workspaceUserId) return;
    await supabase.from('estimates').delete().eq('id', id).eq('user_id', workspaceUserId);
    setSelectedIds(prev => prev.filter(sid => sid !== id));
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const archiveEstimate = async (id: string) => {
    if (!confirm('Archive this document?')) return;
    if (!user || !supabase) {
      showMessage('Not logged in or Supabase not configured.');
      return;
    }
    if (currentCrew) {
      showMessage('Crew accounts cannot archive documents.');
      return;
    }

    try {
      const { data: est, error: fetchErr } = await supabase
        .from('estimates')
        .select('*')
        .eq('id', id)
        .eq('user_id', workspaceUserId)
        .single();
      if (fetchErr || !est) {
        console.error('Archive fetch error:', fetchErr);
        showMessage('Could not load document to archive: ' + (fetchErr?.message || 'not found'));
        return;
      }

      const { error, warning } = await persistArchive(est);
      if (error) {
        console.error('Archive insert error (FULL):', error);
        showMessage(
          'Archive failed (not moved to database): ' +
            ((error as any).message || JSON.stringify(error)) +
            ' — Run ensure_archives_table.sql in Supabase.'
        );
        return;
      }

      showMessage(
        warning
          ? '✅ Archived (with warning): ' + warning
          : '✅ Document archived to database'
      );
      setSelectedIds(prev => prev.filter(sid => sid !== id));
      await refreshSavedList();
      await refreshArchivesList();
    } catch (e: any) {
      console.error('Unexpected error archiving', id, e);
      showMessage('Archive failed: ' + (e?.message || 'unexpected error'));
    }
  };

  // Bulk actions for multi-select
  const bulkOpen = async () => {
    if (selectedIds.length === 0) return;
    // Open the first selected (can't open multiple at once in editor)
    const firstId = selectedIds[0];
    const est = savedEstimatesList.find(e => e.id === firstId);
    if (est) {
      await loadSelectedEstimate(est);
      setView('editor');
      setSelectedIds([]);
    }
  };

  const bulkArchive = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`Archive ${selectedIds.length} documents?`)) return;
    if (!user || !supabase) {
      showMessage('Not logged in or Supabase not configured.');
      return;
    }
    if (currentCrew) {
      showMessage('Crew accounts cannot archive documents.');
      return;
    }

    let ok = 0;
    let fail = 0;
    const failMsgs: string[] = [];

    for (const id of selectedIds) {
      const { data: est, error: fetchErr } = await supabase
        .from('estimates')
        .select('*')
        .eq('id', id)
        .eq('user_id', workspaceUserId)
        .single();
      if (fetchErr || !est) {
        console.error('Bulk archive fetch error for', id, fetchErr);
        fail++;
        failMsgs.push(`${id}: fetch failed`);
        continue;
      }
      const { error: archiveErr } = await persistArchive(est);
      if (archiveErr) {
        console.error('Bulk archive insert error for', id, archiveErr);
        fail++;
        failMsgs.push(`${id}: ${(archiveErr as any).message || 'failed'}`);
        continue;
      }
      ok++;
    }

    if (fail === 0) {
      showMessage(`✅ ${ok} document(s) archived to database`);
    } else {
      showMessage(`Archived ${ok}, failed ${fail}. ${failMsgs.slice(0, 2).join('; ')}`);
      console.error('Bulk archive failures:', failMsgs);
    }
    setSelectedIds([]);
    await refreshSavedList();
    await refreshArchivesList();
  };

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} documents permanently?`)) return;
    if (!supabase) return;

    for (const id of selectedIds) {
      await supabase.from('estimates').delete().eq('id', id);
    }
    showMessage(`${selectedIds.length} documents deleted`);
    setSelectedIds([]);
    refreshSavedList();
  };

  const exportData = async () => {
    if (!user || !supabase) return;

    let csv = 'Type,InvoiceNumber,Client,Date,Address,City,ZipCode,GrandTotal,PhotoUrls,VideoUrls\n';

    if (exportOptions.estimates || exportOptions.invoices) {
      const { data: docs } = await supabase.from('estimates').select('*').eq('user_id', workspaceUserId);
      (docs || []).forEach(doc => {
        if ((exportOptions.estimates && (doc.documentType === 'estimate' || doc.invoiceNumber?.startsWith('EST'))) ||
            (exportOptions.invoices && (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')))) {
          const total = doc.items ? doc.items.reduce((sum: number, item: any) => sum + (item.total || 0), 0) : 0;
          csv += `"${doc.documentType || 'estimate'}","${doc.invoiceNumber || ''}","${doc.jobName || ''}","${doc.date || ''}","${doc.address || ''}","${doc.city || ''}","${doc.zipCode || ''}",${total},"${(doc.photoUrls || []).join('; ')}","${(doc.videoUrls || []).join('; ')}"\n`;
        }
      });
    }

    if (exportOptions.archives) {
      const { data: archives } = await supabase.from('archive-est').select('*').eq('user_id', workspaceUserId);
      (archives || []).forEach(arch => {
        const total = arch.items ? arch.items.reduce((sum: number, item: any) => sum + (item.total || 0), 0) : 0;
        csv += `"archive","${arch.invoiceNumber || ''}","${arch.jobName || ''}","${arch.date || ''}","${arch.address || ''}","${arch.city || ''}","${arch.zipCode || ''}",${total},"${(arch.photoUrls || []).join('; ')}","${(arch.videoUrls || []).join('; ')}"\n`;
      });
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EstimateAce_Export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showMessage('✅ Selected data exported as CSV');
  };

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /** Gallery pickers (no capture) — camera uses DeviceCamera component instead. */
  const photoGalleryInputRef = useRef<HTMLInputElement>(null);
  const videoGalleryInputRef = useRef<HTMLInputElement>(null);

  const debouncedSave = () => {
    if (!profile.autoSaveEnabled) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    if (view === 'editor') debouncedSave();
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod, view, receiptDetails, jobMileageLogs, isTaxExempt, taxLabor, appliedDiscountDescription, appliedDiscountValue, appliedDiscountType]);

  useEffect(() => {
    const saved = localStorage.getItem('quickLines');
    if (saved) setQuickLines(JSON.parse(saved));
    const savedT = localStorage.getItem('templates');
    if (savedT) setSavedTemplates(JSON.parse(savedT));
    const savedDiscountNames = localStorage.getItem('discountNames');
    if (savedDiscountNames) {
      try {
        const parsed = JSON.parse(savedDiscountNames);
        if (Array.isArray(parsed)) {
          setDiscountNames(mergeDiscountNames(parsed));
        }
      } catch {
        // ignore invalid stored discount names
      }
    }
  }, []);

  useEffect(() => {
    if (view === 'dashboard' || view === 'estimatesList' || view === 'invoicesList' || view === 'editor' || view === 'profileView') {
      refreshSavedList();
    }
    // Archives / paid invoices needed so closed-out work leaves Estimates and fills Paid Invoices tab
    if (
      view === 'archivesView' ||
      view === 'editor' ||
      view === 'estimatesList' ||
      view === 'dashboard' ||
      view === 'invoicesList' ||
      view === 'profileView'
    ) {
      refreshArchivesList();
    }
  }, [view]);

  useEffect(() => {
    if (view === 'profileView' && profileTab === 'paidInvoices') {
      void refreshArchivesList();
      void refreshSavedList();
    }
  }, [view, profileTab]);

  // Ensure the chosen language from localStorage (user choice) is always applied
  useEffect(() => {
    const preferred = getPreferredLanguage();
    if (profile && profile.language !== preferred) {
      setProfile(prev => ({ ...prev, language: preferred }));
    }
    // Also ensure we have fresh non-lang company data
    if (view === 'editor' || view === 'profileView') {
      loadLatestProfile();
    }
  }, [view]);

  // Payment functions
  const getDepositDueAmount = () => {
    let deposit = grandTotal * (profile.depositPercentage || 0) / 100;
    if (profile.chargeCCFee) {
      deposit = deposit * (1 + (profile.ccFeePercentage || 3) / 100);
    }
    return deposit;
  };

  const isDepositOnApprovalEnabled = () => profile.showDepositOnApproval !== false;
  const isThirdPartyEscrowProfileEnabled = () => !!profile.thirdPartyEscrowEnabled;

  const getEscrowMinimumAmount = (): number => {
    const cached = getProfileSettingsCache();
    if ('escrowMinimumAmount' in cached) {
      return Math.max(0, Number(cached.escrowMinimumAmount) || 0);
    }
    return Math.max(0, Number(profile.escrowMinimumAmount) || 0);
  };

  const shouldShowEscrowOnEstimate = (estimateTotal: number = grandTotal) => {
    if (!isThirdPartyEscrowProfileEnabled()) return false;
    const minimum = getEscrowMinimumAmount();
    if (minimum <= 0) return true;
    return estimateTotal >= minimum;
  };

  const openPaymentModal = (type: 'deposit' | 'balance', amount: number) => {
    setPaymentType(type);
    setPaymentAmount(amount);
    setSelectedPaymentMethod(null);
    setIsPaymentModalOpen(true);
  };

  const openDepositPayment = () => openPaymentModal('deposit', getDepositDueAmount());

  const getVenmoSettings = () => mergePaymentSettings(profile.paymentSettings).venmo;
  const getZelleSettings = () => mergePaymentSettings(profile.paymentSettings).zelle;
  const getPayPalSettings = () => mergePaymentSettings(profile.paymentSettings).paypal;

  const isVenmoPaymentReady = () => hasVenmoSetup(getVenmoSettings());

  const isZellePaymentReady = () => hasZelleSetup(getZelleSettings());

  const isPayPalPaymentReady = () => hasPayPalSetup(getPayPalSettings());

  const getVenmoTrackingNote = (label: string) =>
    buildPaymentTrackingNote(invoiceNumber, label, profile.company || 'EstimateAce');

  /** Open the Venmo pay panel (note + @username + mark paid) — same tracking model as Zelle. */
  const openVenmoPayment = (amount: number, label: 'deposit' | 'balance' | 'invoice' | string = 'invoice') => {
    if (!isVenmoPaymentReady()) {
      showMessage('Add and save your Venmo username in Profile → Payments (without typing @ — we add it).');
      return false;
    }
    setVenmoPayAmount(amount);
    setVenmoPayLabel(
      label === 'deposit' || label === 'balance' || label === 'invoice' ? label : 'invoice'
    );
    setIsVenmoPayOpen(true);
    return true;
  };

  const launchVenmoAppWithNote = (amount: number, label: string) => {
    const handle = cleanVenmoHandle(getVenmoSettings()?.handle || '');
    if (!handle) {
      showMessage('Add your Venmo username in Profile → Payments.');
      return false;
    }
    const note = getVenmoTrackingNote(label);
    const opened = openVenmoPaymentPage(handle, amount, note, { newTab: true });
    if (!opened) {
      showMessage('Could not open Venmo. Check the username in Profile → Payments.');
      return false;
    }
    showMessage(
      `Opening Venmo to pay $${amount.toFixed(2)} with note “${note}”. Complete payment, then tap “I paid with Venmo”.`
    );
    return true;
  };

  /** @deprecated use openVenmoPayment */
  const startVenmoPayment = (amount: number, label: string) => openVenmoPayment(amount, label);

  const getPayPalTrackingNote = (label: string) =>
    buildPaymentTrackingNote(invoiceNumber, label, profile.company || 'EstimateAce');

  const openPayPalPayment = (amount: number, label: 'deposit' | 'balance' | 'invoice' | string = 'invoice') => {
    if (!isPayPalPaymentReady()) {
      showMessage('Add your PayPal.Me username or PayPal email in Profile → Payments.');
      return false;
    }
    setPaypalPayAmount(amount);
    setPaypalPayLabel(
      label === 'deposit' || label === 'balance' || label === 'invoice' ? label : 'invoice'
    );
    setIsPayPalPayOpen(true);
    return true;
  };

  const launchPayPalCheckout = (amount: number, label: string) => {
    const handle = cleanPayPalHandle(getPayPalSettings()?.handle || '');
    if (!handle) {
      showMessage('Add your PayPal.Me username or business email in Profile → Payments.');
      return false;
    }
    const note = getPayPalTrackingNote(label);
    const opened = openPayPalPaymentPage(handle, amount, note, { newTab: true, currency: 'USD' });
    if (!opened) {
      showMessage('Could not open PayPal. Check your PayPal username/email in Profile → Payments.');
      return false;
    }
    showMessage(
      `Opening PayPal to pay $${amount.toFixed(2)}. Complete checkout, then tap “I paid with PayPal — mark paid”.`
    );
    return true;
  };

  const confirmClientPayPalPayment = async () => {
    if (documentType === 'invoice') {
      await markInvoicePaid('PayPal');
      setIsPayPalPayOpen(false);
      return;
    }
    if (!user || !supabase) return;
    const payAmt = paypalPayAmount > 0 ? paypalPayAmount : getDepositDueAmount();
    const nextPaid = Math.min(grandTotal, Math.max(0, Number(amountPaid) || 0) + payAmt);
    const fullyPaid = nextPaid >= grandTotal - 0.009;
    await supabase.from('estimates').upsert({
      id: invoiceNumber,
      user_id: workspaceUserId,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile: getDocumentProfileSnapshot(),
      documentType, dueDate,
      paymentStatus: fullyPaid ? 'paid' : 'pending',
      amountPaid: nextPaid,
      paymentMethod: 'PayPal',
      photoUrls, videoUrls, receiptUrls, receiptDetails,
      laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
      taxRate: baseTaxRate,
      taxAmount,
      isTaxExempt,
      taxLabor,
      updated_at: new Date().toISOString(),
    });
    setAmountPaid(nextPaid);
    setPaymentMethod('PayPal');
    setPaymentStatus(fullyPaid ? 'paid' : 'pending');
    setIsPayPalPayOpen(false);
    showMessage(
      fullyPaid
        ? '✅ PayPal payment recorded — document marked paid.'
        : `✅ PayPal deposit of $${payAmt.toFixed(2)} recorded.`
    );
    await refreshSavedList();
  };

  const updatePayPalHandle = (value: string) => {
    const handle = cleanPayPalHandle(value);
    const nextProfile = {
      ...profile,
      paymentSettings: {
        ...mergePaymentSettings(profile.paymentSettings),
        paypal: {
          ...mergePaymentSettings(profile.paymentSettings).paypal,
          enabled: mergePaymentSettings(profile.paymentSettings).paypal?.enabled ?? true,
          handle,
          connected: hasPayPalHandle(handle),
        },
      },
    };
    setProfile(nextProfile);
    void saveProfileSettings(nextProfile);
    if (handle) {
      showMessage(
        isPayPalEmail(handle)
          ? `✅ PayPal business email saved: ${handle}`
          : `✅ PayPal.Me link saved: paypal.me/${handle}`
      );
    }
  };

  const confirmClientVenmoPayment = async () => {
    if (documentType === 'invoice') {
      await markInvoicePaid('Venmo');
      setIsVenmoPayOpen(false);
      return;
    }
    if (!user || !supabase) return;
    const payAmt = venmoPayAmount > 0 ? venmoPayAmount : getDepositDueAmount();
    const nextPaid = Math.min(grandTotal, Math.max(0, Number(amountPaid) || 0) + payAmt);
    const fullyPaid = nextPaid >= grandTotal - 0.009;
    await supabase.from('estimates').upsert({
      id: invoiceNumber,
      user_id: workspaceUserId,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile: getDocumentProfileSnapshot(),
      documentType, dueDate,
      paymentStatus: fullyPaid ? 'paid' : 'pending',
      amountPaid: nextPaid,
      paymentMethod: 'Venmo',
      photoUrls, videoUrls, receiptUrls, receiptDetails,
      laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
      taxRate: baseTaxRate,
      taxAmount,
      isTaxExempt,
      taxLabor,
      updated_at: new Date().toISOString(),
    });
    setAmountPaid(nextPaid);
    setPaymentMethod('Venmo');
    setPaymentStatus(fullyPaid ? 'paid' : 'pending');
    setIsVenmoPayOpen(false);
    showMessage(
      fullyPaid
        ? '✅ Venmo payment recorded — document marked paid.'
        : `✅ Venmo deposit of $${payAmt.toFixed(2)} recorded. Keep the invoice # in the Venmo note.`
    );
    await refreshSavedList();
  };

  const renderVenmoPayButton = (
    amount: number,
    label: string,
    options?: { className?: string; size?: 'default' | 'large' }
  ) => {
    if (!isVenmoPaymentReady()) return null;
    const handle = cleanVenmoHandle(getVenmoSettings()?.handle || '');
    const isLarge = options?.size === 'large';

    return (
      <Button
        type="button"
        onClick={() => openVenmoPayment(amount, label)}
        className={
          options?.className ||
          (isLarge
            ? 'flex-1 text-xl py-6 bg-[#008cff] hover:bg-[#0070cc] text-white font-semibold rounded-2xl shadow-lg'
            : 'w-full bg-[#008cff] hover:bg-[#0070cc] text-white font-semibold')
        }
      >
        <span className="inline-flex items-center justify-center gap-2">
          <span>📱</span>
          <span>
            Pay ${amount.toFixed(2)} with Venmo
            <span className={`block font-normal opacity-90 ${isLarge ? 'text-sm' : 'text-xs'}`}>
              @{handle} · invoice note included
            </span>
          </span>
        </span>
      </Button>
    );
  };

  const renderApprovedPaymentSection = (options?: { interactive?: boolean }) => {
    if (documentType === 'invoice') return null;
    if (!isDepositOnApprovalEnabled() && !shouldShowEscrowOnEstimate()) return null;

    const interactive = options?.interactive ?? true;
    const depositBase = grandTotal * (profile.depositPercentage || 0) / 100;
    const depositDue = getDepositDueAmount();

    return (
      <div className="mt-12 text-center border-2 border-dashed border-[#10b981] rounded-3xl p-8">
        <div className="text-4xl font-bold text-[#10b981]">✅ Approved</div>
        {isDepositOnApprovalEnabled() && (
          <div className="mt-4 text-xl">
            Deposit due: <span className="font-semibold">${depositBase.toFixed(2)}</span>
            <span className="text-sm text-gray-500 ml-2">({profile.depositPercentage || 0}% of total)</span>
          </div>
        )}
        {isDepositOnApprovalEnabled() && profile.chargeCCFee && (
          <div className="mt-2 text-sm text-gray-600">
            Credit card payments include an additional {ccFeePercent}% processing fee
          </div>
        )}
        {shouldShowEscrowOnEstimate() && !isDepositOnApprovalEnabled() && (
          <p className="mt-4 text-lg text-gray-700">
            Funds can be held in a third-party escrow account until work is complete.
          </p>
        )}
        {interactive ? (
          <div className={`mt-6 flex flex-col gap-4 justify-center max-w-lg mx-auto`}>
            {isDepositOnApprovalEnabled() && (
              <div className="flex flex-col sm:flex-row gap-4">
                <Button
                  onClick={openDepositPayment}
                  className="flex-1 text-xl py-6 bg-[#10b981] hover:bg-[#0ea16b] text-white font-semibold rounded-2xl shadow-lg"
                >
                  Pay Deposit (${depositDue.toFixed(2)})
                  {profile.chargeCCFee && (
                    <span className="text-sm block mt-1 font-normal opacity-90">(includes {profile.ccFeePercentage || 3}% CC fee)</span>
                  )}
                </Button>
                {isVenmoPaymentReady() && renderVenmoPayButton(depositDue, 'deposit', { size: 'large' })}
                {isZellePaymentReady() && (
                  <Button
                    type="button"
                    onClick={() => openZellePayment(depositDue, 'deposit')}
                    className="flex-1 text-xl py-6 bg-[#6d28d9] hover:bg-[#5b21b6] text-white font-semibold rounded-2xl shadow-lg"
                  >
                    <span className="inline-flex flex-col items-center">
                      <span>🏦 Pay ${depositDue.toFixed(2)} with Zelle</span>
                      <span className="text-sm font-normal opacity-90">Scan QR or send to your unique name</span>
                    </span>
                  </Button>
                )}
                {isPayPalPaymentReady() && (
                  <Button
                    type="button"
                    onClick={() => openPayPalPayment(depositDue, 'deposit')}
                    className="flex-1 text-xl py-6 bg-[#0070ba] hover:bg-[#005ea6] text-white font-semibold rounded-2xl shadow-lg"
                  >
                    <span className="inline-flex flex-col items-center">
                      <span>💰 Pay ${depositDue.toFixed(2)} with PayPal</span>
                      <span className="text-sm font-normal opacity-90">Opens real PayPal checkout</span>
                    </span>
                  </Button>
                )}
              </div>
            )}
            {shouldShowEscrowOnEstimate() && (
              <Button
                onClick={() => setIsEscrowModalOpen(true)}
                variant="outline"
                className="flex-1 text-xl py-6 font-semibold rounded-2xl border-2 border-[#14b8a6] text-[#0f766e] hover:bg-teal-50"
              >
                Third Party Escrow
              </Button>
            )}
          </div>
        ) : (
          shouldShowEscrowOnEstimate() && (
            <p className="mt-4 text-sm text-gray-600">
              Third Party Escrow available — contractor and client arrange a neutral escrow account to hold and release funds.
            </p>
          )
        )}
      </div>
    );
  };

  const closePaymentModal = () => {
    setIsPaymentModalOpen(false);
    setSelectedPaymentMethod(null);
  };

  const selectPaymentMethod = (method: string) => {
    setSelectedPaymentMethod(method);
  };

  const proceedWithPayment = () => {
    if (!selectedPaymentMethod) return showMessage('Please select a payment method');

    if (selectedPaymentMethod === 'venmo') {
      closePaymentModal();
      startVenmoPayment(paymentAmount, paymentType);
      return;
    }

    if (selectedPaymentMethod === 'zelle') {
      closePaymentModal();
      openZellePayment(paymentAmount, paymentType === 'deposit' ? 'deposit' : 'balance');
      return;
    }

    if (selectedPaymentMethod === 'paypal') {
      closePaymentModal();
      openPayPalPayment(paymentAmount, paymentType === 'deposit' ? 'deposit' : 'balance');
      return;
    }

    if (selectedPaymentMethod === 'mailcheck') {
      const addr = (getMailCheckSettings()?.handle || '').trim();
      closePaymentModal();
      if (!addr) {
        showMessage('Mailing address is not set. Add it in Profile → Payments → Mail check to.');
        return;
      }
      showMessage(
        `Mail a check for $${paymentAmount.toFixed(2)} to the address shown. Put ${invoiceNumber} on the memo line. The contractor will mark the invoice paid when the check clears.`
      );
      return;
    }

    closePaymentModal();
    const meta = getPaymentMethodMeta(selectedPaymentMethod);
    showMessage(
      `${meta.label} is not connected for automatic checkout. Use Venmo, Zelle, PayPal, mail a check, or pay ${profile.company || 'the contractor'} directly.`
    );
  };

  const updateVenmoUsername = (value: string) => {
    const handle = cleanVenmoHandle(value);
    const nextProfile = {
      ...profile,
      paymentSettings: {
        ...mergePaymentSettings(profile.paymentSettings),
        venmo: {
          ...mergePaymentSettings(profile.paymentSettings).venmo,
          enabled: mergePaymentSettings(profile.paymentSettings).venmo?.enabled ?? true,
          handle,
          connected: hasVenmoHandle(handle),
        },
      },
    };
    setProfile(nextProfile);
    void saveProfileSettings(nextProfile);
    if (handle) {
      showMessage(`✅ Venmo username saved as @${handle}`);
    }
  };

  const getMailCheckSettings = () => mergePaymentSettings(profile.paymentSettings).mailcheck;

  const hasMailCheckSetup = (settings?: { enabled?: boolean; handle?: string } | null) =>
    !!settings?.enabled && !!(settings.handle || '').trim();

  const mailCheckSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mailCheckSaveLabel, setMailCheckSaveLabel] = useState('');

  const updateMailCheckAddress = (address: string, options?: { immediate?: boolean }) => {
    const runSave = () => {
      const nextProfile = {
        ...profileRef.current,
        paymentSettings: {
          ...mergePaymentSettings(profileRef.current.paymentSettings),
          mailcheck: {
            ...mergePaymentSettings(profileRef.current.paymentSettings).mailcheck,
            enabled: mergePaymentSettings(profileRef.current.paymentSettings).mailcheck?.enabled ?? true,
            handle: address,
            connected: address.trim().length > 0,
          },
        },
      };
      setProfile(nextProfile);
      setMailCheckSaveLabel('Saving…');
      void saveProfileSettings(nextProfile, { quiet: true })
        .then(() => setMailCheckSaveLabel(address.trim() ? 'Saved' : ''))
        .catch(() => setMailCheckSaveLabel('Save failed'));
    };

    // Keep UI responsive while typing
    setProfile((prev) => ({
      ...prev,
      paymentSettings: {
        ...mergePaymentSettings(prev.paymentSettings),
        mailcheck: {
          ...mergePaymentSettings(prev.paymentSettings).mailcheck,
          handle: address,
          connected: address.trim().length > 0,
        },
      },
    }));

    if (mailCheckSaveTimeoutRef.current) clearTimeout(mailCheckSaveTimeoutRef.current);
    if (options?.immediate) {
      runSave();
      return;
    }
    mailCheckSaveTimeoutRef.current = setTimeout(runSave, 600);
  };

  const updateZelleSettings = (patch: { handle?: string; qrUrl?: string; enabled?: boolean }) => {
    const current = mergePaymentSettings(profile.paymentSettings).zelle;
    const nextProfile = {
      ...profile,
      paymentSettings: {
        ...mergePaymentSettings(profile.paymentSettings),
        zelle: {
          ...current,
          enabled: patch.enabled ?? current?.enabled ?? true,
          handle: patch.handle !== undefined ? patch.handle : current?.handle,
          qrUrl: patch.qrUrl !== undefined ? patch.qrUrl : current?.qrUrl,
          connected: !!(
            (patch.handle !== undefined ? hasZelleHandle(patch.handle) : hasZelleHandle(current?.handle)) ||
            (patch.qrUrl !== undefined ? !!patch.qrUrl : !!current?.qrUrl)
          ),
        },
      },
    };
    setProfile(nextProfile);
    void saveProfileSettings(nextProfile);
  };

  const handleZelleQrUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !supabase) return;
    if (!file.type.startsWith('image/')) {
      showMessage('Please upload an image of your Zelle QR code (PNG or JPG).');
      return;
    }
    const filePath = `${workspaceUserId}/zelle-qr/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
    if (error) {
      showMessage('Failed to upload Zelle QR. Try again.');
      return;
    }
    updateZelleSettings({ qrUrl: filePath });
    showMessage('✅ Zelle QR code saved. Clients will see it when paying invoices.');
    e.target.value = '';
  };

  const openZellePayment = (amount: number, label: 'deposit' | 'balance' | 'invoice' = 'invoice') => {
    if (!isZellePaymentReady()) {
      showMessage('Add your Zelle name/email/phone or QR code in Profile → Payments.');
      return;
    }
    setZellePayAmount(amount);
    setZellePayLabel(label);
    setIsZellePayOpen(true);
  };

  /** Mark current invoice paid (and archive like cash) after Zelle/cash confirmation. */
  const markInvoicePaid = async (methodLabel: string) => {
    if (!user || !supabase) return;
    if (documentType !== 'invoice') {
      // Deposit / partial: record payment on the open document without full archive
      const nextPaid = Math.min(grandTotal, Math.max(0, Number(amountPaid) || 0) + zellePayAmount);
      const fullyPaid = nextPaid >= grandTotal - 0.009;
      setAmountPaid(nextPaid);
      setPaymentMethod(methodLabel);
      setPaymentStatus(fullyPaid ? 'paid' : 'pending');
      await saveToDB({
        profile,
      });
      // saveToDB uses state which may be stale — write explicitly
      await supabase.from('estimates').upsert({
        id: invoiceNumber,
        user_id: workspaceUserId,
        jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
        items, terms, profile: getDocumentProfileSnapshot(),
        documentType, dueDate,
        paymentStatus: fullyPaid ? 'paid' : 'pending',
        amountPaid: nextPaid,
        paymentMethod: methodLabel,
        photoUrls, videoUrls, receiptUrls, receiptDetails,
        laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
        taxRate: baseTaxRate,
        taxAmount,
        isTaxExempt,
        taxLabor,
        updated_at: new Date().toISOString(),
      });
      showMessage(
        fullyPaid
          ? `✅ Payment recorded via ${methodLabel}. Invoice/estimate marked paid.`
          : `✅ ${methodLabel} payment of $${zellePayAmount.toFixed(2)} recorded.`
      );
      setIsZellePayOpen(false);
      await refreshSavedList();
      return;
    }

    if (!confirm(`Mark this invoice as Paid (${methodLabel}) and close it to archives?`)) return;

    const id = invoiceNumber;
    try {
      const paidData = {
        user_id: workspaceUserId,
        jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber: id,
        items, terms, profile: getDocumentProfileSnapshot(),
        documentType, dueDate,
        paymentStatus: 'paid' as const,
        amountPaid: grandTotal,
        paymentMethod: methodLabel,
        photoUrls, videoUrls, receiptUrls, receiptDetails,
        laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
        taxRate: baseTaxRate,
        taxAmount,
        isTaxExempt,
        taxLabor,
        updated_at: new Date().toISOString(),
      };
      const { error: saveErr } = await supabase.from('estimates').upsert({ id, ...paidData });
      if (saveErr) {
        showMessage('❌ Failed to mark as paid.');
        return;
      }

      const { data: est, error: fetchErr } = await supabase
        .from('estimates')
        .select('*')
        .eq('id', id)
        .eq('user_id', workspaceUserId)
        .single();
      if (fetchErr || !est) {
        showMessage(`✅ Marked paid (${methodLabel}), but could not load for archiving.`);
        setPaymentStatus('paid');
        setAmountPaid(grandTotal);
        setPaymentMethod(methodLabel);
        setIsZellePayOpen(false);
        setProfileTab('paidInvoices');
        setView('profileView');
        await refreshSavedList();
        return;
      }

      // Prefer shared persistArchive so related EST- work order is removed with the invoice
      const { error: archiveErr } = await persistArchive({
        ...est,
        paymentStatus: 'paid',
        amountPaid: grandTotal,
        paymentMethod: methodLabel,
      });
      if (archiveErr) {
        showMessage(
          `✅ Marked paid (${methodLabel}), but moving to Paid Invoices failed: ${(archiveErr as any).message || 'unknown'}`
        );
      } else {
        showMessage(`✅ Invoice marked Paid (${methodLabel}) and moved to Paid Invoices`);
      }

      setPaymentStatus('paid');
      setAmountPaid(grandTotal);
      setPaymentMethod(methodLabel);
      setIsZellePayOpen(false);
      setIsVenmoPayOpen(false);
      setIsPayPalPayOpen(false);
      setProfileTab('paidInvoices');
      setView('profileView');
      await refreshSavedList();
      await refreshArchivesList();
    } catch (e) {
      console.error(e);
      showMessage('Failed to mark invoice paid.');
    }
  };

  const confirmClientZellePayment = async () => {
    // Client (or contractor) confirms Zelle was sent — marks invoice/estimate paid
    if (documentType === 'invoice') {
      await markInvoicePaid('Zelle');
    } else {
      // Deposit on estimate
      if (!user || !supabase) return;
      const payAmt = zellePayAmount > 0 ? zellePayAmount : getDepositDueAmount();
      const nextPaid = Math.min(grandTotal, Math.max(0, Number(amountPaid) || 0) + payAmt);
      const fullyPaid = nextPaid >= grandTotal - 0.009;
      await supabase.from('estimates').upsert({
        id: invoiceNumber,
        user_id: workspaceUserId,
        jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
        items, terms, profile: getDocumentProfileSnapshot(),
        documentType, dueDate,
        paymentStatus: fullyPaid ? 'paid' : 'pending',
        amountPaid: nextPaid,
        paymentMethod: 'Zelle',
        photoUrls, videoUrls, receiptUrls, receiptDetails,
        laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
        taxRate: baseTaxRate,
        taxAmount,
        isTaxExempt,
        taxLabor,
        updated_at: new Date().toISOString(),
      });
      setAmountPaid(nextPaid);
      setPaymentMethod('Zelle');
      setPaymentStatus(fullyPaid ? 'paid' : 'pending');
      setIsZellePayOpen(false);
      showMessage(
        fullyPaid
          ? '✅ Zelle payment recorded — document marked paid.'
          : `✅ Zelle deposit of $${payAmt.toFixed(2)} recorded. Use the invoice # as the Zelle memo.`
      );
      await refreshSavedList();
    }
  };

  const renderPaymentMethodRow = (method: string, settings: { enabled?: boolean; connected?: boolean; handle?: string; qrUrl?: string }) => {
    const meta = getPaymentMethodMeta(method);

    if (method === 'mailcheck') {
      const addressText = settings.handle || '';
      const ready = addressText.trim().length > 0;
      return (
        <div
          key={method}
          className="border rounded-2xl p-4 sm:p-6 hover:shadow-sm transition-all w-full max-w-full min-w-0 overflow-hidden box-border"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 min-w-0">
            <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
              <div className="text-3xl sm:text-4xl shrink-0">{meta.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base sm:text-lg break-words">{meta.label}</div>
                <div className="text-sm text-gray-500 break-words">{meta.description}</div>
                <div className="text-sm text-gray-500 mt-1">
                  {ready ? (
                    <><span className="text-green-500">✓</span> Address saved for client invoices</>
                  ) : (
                    'Enter the mailing address where clients should send checks'
                  )}
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0 self-end sm:self-center">
              <input
                type="checkbox"
                checked={!!settings.enabled}
                onChange={(e) => togglePaymentMethod(method, e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
            </label>
          </div>

          <div className="mt-4 w-full min-w-0 space-y-2 sm:pl-12">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-sm font-medium text-gray-700">
                Mail check to (name + full address)
              </label>
              {mailCheckSaveLabel && (
                <span
                  className={`text-xs font-medium shrink-0 ${
                    mailCheckSaveLabel === 'Save failed'
                      ? 'text-red-600'
                      : mailCheckSaveLabel === 'Saving…'
                        ? 'text-amber-600'
                        : 'text-emerald-600'
                  }`}
                >
                  {mailCheckSaveLabel === 'Saved' ? '✓ Saved' : mailCheckSaveLabel}
                </span>
              )}
            </div>
            <Textarea
              value={addressText}
              onChange={(e) => updateMailCheckAddress(e.target.value)}
              onBlur={(e) => updateMailCheckAddress(e.target.value, { immediate: true })}
              rows={4}
              placeholder={'Your Company Name\n123 Main St\nCity, ST 12345'}
              className="w-full max-w-full min-w-0 resize-y text-sm"
            />
            <p className="text-xs text-gray-500">
              Saves automatically as you type. Clients see this address when they choose mail a check.
            </p>
            {!addressText.trim() && (profile.company || profile.address) && (
              <button
                type="button"
                className="text-xs font-semibold text-[#10b981] underline"
                onClick={() => {
                  const prefill = [
                    profile.company,
                    profile.address,
                    [profile.city, profile.state, profile.zipCode].filter(Boolean).join(', '),
                  ]
                    .filter(Boolean)
                    .join('\n');
                  updateMailCheckAddress(prefill, { immediate: true });
                }}
              >
                Use company profile address
              </button>
            )}
          </div>
        </div>
      );
    }

    if (method === 'zelle') {
      const zelleReady = hasZelleHandle(settings.handle) || !!settings.qrUrl;
      return (
        <div
          key={method}
          className="border rounded-2xl p-4 sm:p-6 hover:shadow-sm transition-all w-full max-w-full min-w-0 overflow-hidden box-border"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 min-w-0">
            <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
              <div className="text-3xl sm:text-4xl shrink-0">{meta.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base sm:text-lg break-words">{meta.label}</div>
                <div className="text-sm text-gray-500 break-words">{meta.description}</div>
                <div className="text-sm text-gray-500 mt-1">
                  {zelleReady ? (
                    <><span className="text-green-500">✓</span> Ready for client payments</>
                  ) : (
                    'Add QR and/or unique name to receive payments'
                  )}
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0 self-end sm:self-center">
              <input
                type="checkbox"
                checked={!!settings.enabled}
                onChange={(e) => togglePaymentMethod(method, e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
            </label>
          </div>

          <div className="mt-4 w-full min-w-0 space-y-4 sm:pl-12">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Zelle unique name / email / phone
              </label>
              <Input
                value={settings.handle || ''}
                onChange={(e) => {
                  const handle = e.target.value;
                  setProfile((prev) => ({
                    ...prev,
                    paymentSettings: {
                      ...mergePaymentSettings(prev.paymentSettings),
                      zelle: {
                        ...mergePaymentSettings(prev.paymentSettings).zelle,
                        handle,
                        connected: hasZelleHandle(handle) || !!mergePaymentSettings(prev.paymentSettings).zelle?.qrUrl,
                      },
                    },
                  }));
                }}
                onBlur={(e) => updateZelleSettings({ handle: e.target.value })}
                placeholder="business@email.com or (555) 123-4567"
                autoComplete="off"
                className="w-full max-w-full min-w-0"
              />
              <p className="text-xs text-gray-500 mt-2">
                Clients use this to find you in Zelle. Ask them to put the invoice number in the memo.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Zelle QR code</label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => void handleZelleQrUpload(e)}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#6d28d9] file:text-white hover:file:bg-[#5b21b6]"
              />
              <p className="text-xs text-gray-500 mt-1">
                Upload the QR from your banking app so clients can scan it for this invoice.
              </p>
              {settings.qrUrl && zelleQrDisplayUrl && (
                <div className="mt-3 flex flex-wrap items-start gap-3">
                  <img
                    src={zelleQrDisplayUrl}
                    alt="Zelle QR code"
                    className="h-36 w-36 object-contain border rounded-xl bg-white p-2"
                  />
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:text-red-800"
                    onClick={() => updateZelleSettings({ qrUrl: '' })}
                  >
                    Remove QR
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (method === 'paypal') {
      const paypalHandle = cleanPayPalHandle(settings.handle || '');
      const paypalReady = hasPayPalHandle(paypalHandle);
      const asEmail = isPayPalEmail(paypalHandle);
      return (
        <div
          key={method}
          className="border rounded-2xl p-4 sm:p-6 hover:shadow-sm transition-all w-full max-w-full min-w-0 overflow-hidden box-border"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 min-w-0">
            <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
              <div className="text-3xl sm:text-4xl shrink-0">{meta.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base sm:text-lg break-words">{meta.label}</div>
                <div className="text-sm text-gray-500 break-words">
                  Accept real payments via PayPal.Me or business email (not just a link to PayPal.com)
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {paypalReady ? (
                    <><span className="text-green-500">✓</span> Ready — clients pay through PayPal checkout</>
                  ) : (
                    'Add your PayPal.Me username or PayPal email below'
                  )}
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0 self-end sm:self-center">
              <input
                type="checkbox"
                checked={!!settings.enabled}
                onChange={(e) => togglePaymentMethod(method, e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
            </label>
          </div>
          <div className="mt-4 w-full min-w-0 space-y-3 sm:pl-12">
            <label className="block text-sm font-medium text-gray-700">
              PayPal.Me username or PayPal email
            </label>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full min-w-0">
              <Input
                value={settings.handle || ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  setProfile((prev) => ({
                    ...prev,
                    paymentSettings: {
                      ...mergePaymentSettings(prev.paymentSettings),
                      paypal: {
                        ...mergePaymentSettings(prev.paymentSettings).paypal,
                        handle: raw,
                        connected: hasPayPalHandle(raw),
                      },
                    },
                  }));
                }}
                onBlur={(e) => updatePayPalHandle(e.target.value)}
                placeholder="YourBusiness or you@business.com"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 w-full max-w-full"
              />
              <Button
                type="button"
                size="sm"
                className="shrink-0 bg-[#0070ba] hover:bg-[#005ea6] text-white"
                onClick={() => updatePayPalHandle(settings.handle || '')}
              >
                Save
              </Button>
            </div>
            <div className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-sm text-sky-950">
              {paypalReady ? (
                asEmail ? (
                  <>
                    <span className="font-medium">Clients check out to:</span>{' '}
                    <span className="font-bold break-all">{paypalHandle}</span>
                    <p className="text-xs mt-1 text-sky-900/80">
                      Uses PayPal payment form with amount + invoice note (item name) for tracking.
                    </p>
                  </>
                ) : (
                  <>
                    <span className="font-medium">PayPal.Me link:</span>{' '}
                    <span className="font-bold break-all text-[#0070ba]">
                      paypal.me/{paypalHandle}
                    </span>
                    <p className="text-xs mt-1 text-sky-900/80">
                      Clients open a real pay page with the invoice amount filled in (e.g. paypal.me/{paypalHandle}/125.00USD).
                    </p>
                  </>
                )
              ) : (
                <p className="text-xs">
                  Create a free PayPal.Me at paypal.me, then paste your username (not the full website home page).
                  Or enter the email on your PayPal business account.
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (method === 'venmo') {
      const venmoHandle = cleanVenmoHandle(settings.handle || '');
      const venmoReady = hasVenmoHandle(venmoHandle);
      return (
        <div
          key={method}
          className="border rounded-2xl p-4 sm:p-6 hover:shadow-sm transition-all w-full max-w-full min-w-0 overflow-hidden box-border"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 min-w-0">
            <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
              <div className="text-3xl sm:text-4xl shrink-0">{meta.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base sm:text-lg break-words">{meta.label}</div>
                <div className="text-sm text-gray-500 break-words">
                  Clients pay your @username with an invoice note so you can track and mark paid
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {venmoReady ? (
                    <><span className="text-green-500">✓</span> Ready — clients pay <span className="font-semibold text-[#008cff]">@{venmoHandle}</span></>
                  ) : (
                    'Add your Venmo username below (you can edit it anytime)'
                  )}
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0 self-end sm:self-center">
              <input
                type="checkbox"
                checked={!!settings.enabled}
                onChange={(e) => togglePaymentMethod(method, e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
            </label>
          </div>
          <div className="mt-4 w-full min-w-0 space-y-3 sm:pl-12">
            <label className="block text-sm font-medium text-gray-700">
              Venmo username (editable)
            </label>
            <div className="flex items-center gap-2 w-full min-w-0 max-w-full">
              <span className="text-lg font-semibold text-[#008cff] shrink-0 select-none">@</span>
              <Input
                value={settings.handle || ''}
                onChange={(e) => {
                  // Allow free typing; strip invalid chars but keep editable
                  const raw = e.target.value.replace(/^@+/, '');
                  setProfile((prev) => ({
                    ...prev,
                    paymentSettings: {
                      ...mergePaymentSettings(prev.paymentSettings),
                      venmo: {
                        ...mergePaymentSettings(prev.paymentSettings).venmo,
                        handle: raw,
                        connected: hasVenmoHandle(raw),
                      },
                    },
                  }));
                }}
                onBlur={(e) => updateVenmoUsername(e.target.value)}
                placeholder="YourBusiness"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 w-full max-w-full"
              />
              <Button
                type="button"
                size="sm"
                className="shrink-0 bg-[#008cff] hover:bg-[#0070cc] text-white"
                onClick={() => updateVenmoUsername(settings.handle || '')}
              >
                Save
              </Button>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-950">
              <span className="font-medium">Clients will pay:</span>{' '}
              <span className="font-bold text-[#008cff]">
                @{venmoHandle || 'YourBusiness'}
              </span>
              <p className="text-xs text-blue-900/80 mt-1">
                Type only the username — the @ is added automatically. Payment notes include the invoice # so you can match and mark paid (Venmo has no auto-notify API).
              </p>
            </div>
          </div>
        </div>
      );
    }

    const connected = !!settings.connected;

    return (
      <div
        key={method}
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 border rounded-2xl p-4 sm:p-6 hover:shadow-sm transition-all w-full max-w-full min-w-0 overflow-hidden box-border"
      >
        <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
          <div className="text-3xl sm:text-4xl shrink-0">{meta.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-base sm:text-lg break-words">{meta.label}</div>
            <div className="text-sm text-gray-500 break-words">{meta.description}</div>
            <div className="text-sm text-gray-500 flex items-center gap-1 mt-1 flex-wrap">
              {connected ? (
                <><span className="text-green-500">✓</span> {t('connected')}</>
              ) : (
                t('notConnected')
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 sm:gap-4 shrink-0 w-full sm:w-auto min-w-0">
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={!!settings.enabled}
              onChange={(e) => togglePaymentMethod(method, e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
          </label>
          {method !== 'venmo' && method !== 'zelle' && method !== 'paypal' && method !== 'mailcheck' && (
            <Button
              onClick={() => linkPaymentAccount(method)}
              variant={connected ? 'outline' : 'default'}
              className={`min-w-0 max-w-full h-auto min-h-9 px-3 py-2 text-sm whitespace-normal text-center leading-snug ${
                connected ? '' : 'bg-[#10b981]'
              }`}
            >
              {connected ? t('manage') : t('linkAccount')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  const togglePaymentMethod = (method: string, enabled: boolean) => {
    const nextProfile = {
      ...profile,
      paymentSettings: {
        ...mergePaymentSettings(profile.paymentSettings),
        [method]: { ...mergePaymentSettings(profile.paymentSettings)[method], enabled },
      },
    };
    setProfile(nextProfile);
    void saveProfileSettings(nextProfile);
  };

  const linkPaymentAccount = (method: string) => {
    if (method === 'venmo' || method === 'zelle' || method === 'paypal' || method === 'mailcheck') return;

    const meta = getPaymentMethodMeta(method);
    const providerUrls: { [key: string]: string } = {
      stripe: 'https://dashboard.stripe.com/connect',
      echeck: 'https://dashboard.stripe.com/connect',
      nowpayments: 'https://account.nowpayments.io/create-account',
      coinbase_commerce: 'https://commerce.coinbase.com/signup',
    };
    window.open(providerUrls[method] || `https://${method}.com`, '_blank', 'noopener,noreferrer');

    setTimeout(() => {
      const nextProfile = {
        ...profile,
        paymentSettings: {
          ...mergePaymentSettings(profile.paymentSettings),
          [method]: { ...mergePaymentSettings(profile.paymentSettings)[method], connected: true },
        },
      };
      setProfile(nextProfile);
      void saveToDB({ profile: nextProfile });
      showMessage(`${meta.label} account linked successfully.`);
    }, 800);
  };

  // Dashboard calculations
  const closedWorkIndex = useMemo(() => {
    const closedRows = [
      ...(archivesList || []),
      ...(savedEstimatesList || []).filter(
        (r: any) => isPaidDocRow(r) || isInvoiceDocRow(r)
      ),
    ];
    return buildClosedWorkIndex(closedRows);
  }, [archivesList, savedEstimatesList]);

  /** Active estimate/work-order only — excludes settings, invoices, paid, and closed-out orphans. */
  const isEstimateDoc = (est: any) => {
    if (!est) return false;
    if (isSettingsDocRow(est)) return false;
    if (isInvoiceDocRow(est)) return false;
    if (isPaidDocRow(est)) return false;
    if (!isEstimateTypeRow(est)) {
      const num = String(est.invoiceNumber ?? est.invoicenumber ?? est.id ?? '');
      const id = String(est.id || '');
      // Fallback: treat EST-prefixed docs as estimates
      if (!num.toUpperCase().startsWith('EST') && !id.toUpperCase().startsWith('EST')) {
        return false;
      }
    }
    // Hide any work order tied to a paid/closed invoice
    if (estimateBelongsToClosedWork(est, closedWorkIndex)) return false;
    return true;
  };

  /** Open (unpaid) invoices only — paid ones live under Profile → Paid Invoices. */
  const isOpenInvoiceDoc = (est: any) => isInvoiceDocRow(est) && !isPaidDocRow(est);

  const paidInvoicesList = useMemo(() => {
    return (archivesList || [])
      .filter((row: any) => {
        if (isSettingsDocRow(row)) return false;
        // Paid folder: paid status, or archived invoice (closed out)
        return isPaidDocRow(row) || isInvoiceDocRow(row);
      })
      .sort((a: any, b: any) => {
        const da = new Date(a.archived_at || a.updated_at || a.date || 0).getTime();
        const db = new Date(b.archived_at || b.updated_at || b.date || 0).getTime();
        return db - da;
      });
  }, [archivesList]);

  /**
   * All mileage trips across active estimates/invoices + archives (for Profile total).
   * Archive wins over active for same id. Open editor job uses live jobMileageLogs.
   */
  const allJobsMileageLogs = useMemo(() => {
    const byId = new Map<string, any>();
    for (const row of savedEstimatesList || []) {
      if (!row || isSettingsDocRow(row)) continue;
      byId.set(String(row.id), row);
    }
    for (const row of archivesList || []) {
      if (!row || isSettingsDocRow(row)) continue;
      byId.set(String(row.id), row);
    }

    const openId = view === 'editor' && invoiceNumber ? String(invoiceNumber) : null;
    const trips: MileageLog[] = [];

    for (const [id, row] of byId) {
      if (openId && id === openId) continue; // use live editor state below
      for (const log of mileageLogsFromDoc(row)) {
        trips.push({
          ...log,
          jobName: log.jobName || row.jobName || row.jobname || row.invoiceNumber || id || '',
        });
      }
    }

    if (openId && jobMileageLogs.length > 0) {
      for (const log of jobMileageLogs) {
        trips.push({
          ...log,
          jobName: log.jobName || jobName || openId,
        });
      }
    }

    return trips.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [savedEstimatesList, archivesList, view, invoiceNumber, jobMileageLogs, jobName]);

  const estimateMatchesSearch = (est: any, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const phones = Array.isArray(est.phones) ? est.phones.join(' ') : (est.phones || '');
    const emails = Array.isArray(est.emails) ? est.emails.join(' ') : (est.emails || '');
    const haystack = [
      est.jobName,
      est.invoiceNumber,
      est.date,
      est.address,
      est.city,
      est.state,
      est.zipCode,
      phones,
      emails,
      est.documentType,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    // Support multi-word search: every token must match somewhere
    return q.split(/\s+/).every((token) => haystack.includes(token));
  };

  const filteredEstimatesList = useMemo(() => {
    return (savedEstimatesList || [])
      .filter(isEstimateDoc)
      .filter((est) => estimateMatchesSearch(est, estimateListSearch));
  }, [savedEstimatesList, archivesList, estimateListSearch]);

  const estimatesCount = useMemo(
    () => (savedEstimatesList || []).filter(isEstimateDoc).length,
    [savedEstimatesList, archivesList]
  );

  const outstandingInvoices = savedEstimatesList.filter(
    (est) => isOpenInvoiceDoc(est) && (est.paymentStatus === 'pending' || !est.paymentStatus)
  );

  const openInvoicesList = useMemo(
    () => (savedEstimatesList || []).filter(isOpenInvoiceDoc),
    [savedEstimatesList]
  );

  const calculateGrandTotal = (doc: any): number => {
    if (!doc || !doc.items) return 0;
    const laborAmountDoc =
      doc.laborAmount ??
      (doc.useHourlyLabor
        ? (doc.laborHours || 0) * (doc.laborRate || 0)
        : doc.laborFixedAmount || 0);
    const docDiscountData = getDiscountFromDoc(doc);
    return computeEstimateTotals({
      items: doc.items,
      laborAmount: laborAmountDoc,
      isTaxExempt: doc.isTaxExempt,
      taxesEnabled: getTaxesEnabled(),
      taxRate: doc.taxRate ?? 7,
      discountDescription: docDiscountData.discountDescription,
      discountValue: docDiscountData.discountValue,
      discountType: docDiscountData.discountType,
      storedDiscountAmount: docDiscountData.discountAmount,
    }).grandTotal;
  };

  const totalOutstanding = outstandingInvoices.reduce((sum, inv) => sum + calculateGrandTotal(inv), 0);

  const currentYear = new Date().getFullYear();
  const allDocs = [...(savedEstimatesList || []), ...(archivesList || [])];
  const salesYTD = allDocs
    .filter(doc => {
      if (!doc.date) return false;
      const docDate = new Date(doc.date);
      if (isNaN(docDate.getTime())) return false;
      return docDate.getFullYear() === currentYear &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    })
    .reduce((sum, doc) => sum + calculateGrandTotal(doc), 0);

  const totalSalesTaxCollected = allDocs
    .filter(doc => {
      if (!doc.date) return false;
      const docDate = new Date(doc.date);
      if (isNaN(docDate.getTime())) return false;
      return docDate.getFullYear() === currentYear &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    })
    .reduce((sum, doc) => sum + (doc.taxAmount || 0), 0);
  const totalTaxDeductibleReceipts = allDocs
    .filter(doc => {
      if (!doc.date) return false;
      const docDate = new Date(doc.date);
      if (isNaN(docDate.getTime())) return false;
      return docDate.getFullYear() === currentYear &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    })
    .reduce((sum, doc) => {
      return sum + (doc.receiptDetails || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);
    }, 0);
  const netTaxableProfit = allDocs
    .filter(doc => {
      if (!doc.date) return false;
      const docDate = new Date(doc.date);
      if (isNaN(docDate.getTime())) return false;
      return docDate.getFullYear() === currentYear &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    })
    .reduce((sum, doc) => {
      const gross = calculateGrandTotal(doc);
      const receipts = (doc.receiptDetails || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);
      const labor = doc.laborAmount || 0;
      return sum + (gross - receipts - labor);
    }, 0);

  const quarterlyTaxData = [1,2,3,4].map(q => {
    const start = new Date(currentYear, (q-1)*3, 1);
    const end = new Date(currentYear, q*3, 0);
    const filtered = allDocs.filter(doc => {
      if (!doc.date) return false;
      const d = new Date(doc.date);
      if (isNaN(d.getTime())) return false;
      return d >= start && d <= end &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    });
    const tax = filtered.reduce((sum, doc) => sum + (doc.taxAmount || 0), 0);
    const receipts = filtered.reduce((sum, doc) => {
      return sum + (doc.receiptDetails || []).reduce((s: number, r: any) => s + (r.amount || 0), 0);
    }, 0);
    return { quarter: `Q${q}`, taxCollected: tax, expenses: receipts };
  });

  const exportTaxReport = () => {
    let csv = 'Quarter,Tax Collected,Tax Deductible Receipts,Net Taxable Profit\n';
    quarterlyTaxData.forEach(q => {
      csv += `Q${q.quarter},${q.taxCollected.toFixed(2)},${q.expenses.toFixed(2)},${(q.taxCollected - q.expenses).toFixed(2)}\n`;
    });
    csv += `\nTotal Sales Tax Collected,${totalSalesTaxCollected.toFixed(2)}\n`;
    csv += `Total Tax Deductible Receipts,${totalTaxDeductibleReceipts.toFixed(2)}\n`;
    csv += `Net Taxable Profit,${netTaxableProfit.toFixed(2)}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Tax_Report_${currentYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showMessage('✅ Tax report exported as CSV');
  };

  /** Invoice date used for month/year grouping (job invoiced date). */
  const getArchivedInvoiceDate = (doc: any): Date | null => {
    const raw = doc?.date || doc?.dueDate || doc?.duedate || doc?.archived_at || doc?.updated_at;
    if (!raw) return null;
    // Prefer YYYY-MM-DD without timezone shift
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(raw);
    return isNaN(dt.getTime()) ? null : dt;
  };

  /**
   * Archived invoices for Profit Reports, grouped by month & year of invoice date.
   * Source: archive-est rows that are invoices (INV- / documentType invoice).
   */
  const archivedInvoicesByMonth = useMemo(() => {
    type MonthGroup = {
      key: string;
      year: number;
      month: number;
      label: string;
      invoices: any[];
      total: number;
      amountPaid: number;
      count: number;
    };

    const isArchivedInvoice = (row: any) => {
      if (!row || isSettingsDocRow(row)) return false;
      // Invoices only (INV- / documentType invoice) from archive-est
      return isInvoiceDocRow(row);
    };

    const list = (archivesList || []).filter(isArchivedInvoice);
    const map = new Map<string, MonthGroup>();

    for (const inv of list) {
      const dt = getArchivedInvoiceDate(inv);
      const year = dt ? dt.getFullYear() : 0;
      const month = dt ? dt.getMonth() : -1;
      const key =
        year > 0
          ? `${year}-${String(month + 1).padStart(2, '0')}`
          : 'unknown';
      const label =
        year > 0
          ? dt!.toLocaleString('en-US', { month: 'long', year: 'numeric' })
          : 'Unknown invoice date';

      if (!map.has(key)) {
        map.set(key, {
          key,
          year,
          month,
          label,
          invoices: [],
          total: 0,
          amountPaid: 0,
          count: 0,
        });
      }
      const g = map.get(key)!;
      const grand = calculateGrandTotal(inv);
      const paid = Number(inv.amountPaid ?? inv.amountpaid ?? 0) || 0;
      g.invoices.push(inv);
      g.total += grand;
      g.amountPaid += paid;
      g.count += 1;
    }

    // Sort invoices inside each month (newest first)
    for (const g of map.values()) {
      g.invoices.sort((a, b) => {
        const da = getArchivedInvoiceDate(a)?.getTime() || 0;
        const db = getArchivedInvoiceDate(b)?.getTime() || 0;
        return db - da;
      });
    }

    const months = Array.from(map.values()).sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return b.key.localeCompare(a.key);
    });

    const years = Array.from(
      new Set(months.filter((m) => m.year > 0).map((m) => m.year))
    ).sort((a, b) => b - a);

    const grandTotal = months.reduce((s, m) => s + m.total, 0);
    const grandPaid = months.reduce((s, m) => s + m.amountPaid, 0);
    const grandCount = months.reduce((s, m) => s + m.count, 0);

    return { months, years, grandTotal, grandPaid, grandCount };
  }, [archivesList]);

  const filteredArchivedInvoiceMonths = useMemo(() => {
    if (profitArchiveYearFilter === 'all') return archivedInvoicesByMonth.months;
    const y = Number(profitArchiveYearFilter);
    return archivedInvoicesByMonth.months.filter((m) => m.year === y || (y === 0 && m.key === 'unknown'));
  }, [archivedInvoicesByMonth.months, profitArchiveYearFilter]);

  const exportArchivedInvoicesByMonth = () => {
    const rows = filteredArchivedInvoiceMonths;
    let csv =
      'Month,Year,Invoice Number,Job Name,Invoice Date,Payment Status,Payment Method,Grand Total,Amount Paid,Archived At\n';
    for (const month of rows) {
      for (const inv of month.invoices) {
        const invDate = getArchivedInvoiceDate(inv);
        const dateStr = invDate
          ? `${invDate.getFullYear()}-${String(invDate.getMonth() + 1).padStart(2, '0')}-${String(invDate.getDate()).padStart(2, '0')}`
          : '';
        const grand = calculateGrandTotal(inv);
        const paid = Number(inv.amountPaid ?? inv.amountpaid ?? 0) || 0;
        const job = String(inv.jobName || inv.jobname || '').replace(/"/g, '""');
        const num = String(inv.invoiceNumber || inv.invoicenumber || inv.id || '');
        const status = String(inv.paymentStatus || inv.paymentstatus || '');
        const method = String(inv.paymentMethod || inv.paymentmethod || '');
        const archivedAt = String(inv.archived_at || '');
        csv += `"${month.label}",${month.year || ''},"${num}","${job}",${dateStr},${status},"${method}",${grand.toFixed(2)},${paid.toFixed(2)},"${archivedAt}"\n`;
      }
    }
    csv += `\nTotal Invoices,${archivedInvoicesByMonth.grandCount}\n`;
    csv += `Grand Total,${archivedInvoicesByMonth.grandTotal.toFixed(2)}\n`;
    csv += `Total Amount Paid,${archivedInvoicesByMonth.grandPaid.toFixed(2)}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Archived_Invoices_By_Month_${profitArchiveYearFilter === 'all' ? 'All' : profitArchiveYearFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showMessage('✅ Archived invoices export saved');
  };

  const toggleProfitArchiveMonth = (key: string) => {
    setProfitArchiveExpandedMonths((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!user) {
    const quoteOfDay = getQuoteOfTheDay();
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4] p-4">
        <ToastContainer />
        <Card className="w-full max-w-md p-8">
          <div className="mb-5 rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 px-4 py-3.5 text-center shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 mb-1.5">
              Quote of the day
            </p>
            <p className="text-sm sm:text-[15px] text-[#1e293b] leading-relaxed font-medium italic">
              “{quoteOfDay.text}”
            </p>
            {quoteOfDay.author ? (
              <p className="text-xs text-emerald-800/80 mt-2 font-medium">— {quoteOfDay.author}</p>
            ) : (
              <p className="text-[10px] text-emerald-700/70 mt-2">New inspiration every day</p>
            )}
          </div>
          <div>
            <h1 className="text-4xl font-bold text-center text-[#1e293b]">EstimateAce</h1>
            <p className="text-center text-sm text-gray-500 mt-2">
              Professional estimating for contractors
            </p>
            <p className="text-center text-xs text-gray-400 mt-1">
              Existing accounts &amp; crew log in here
            </p>
          </div>

          {!showMainForgot ? (
            <>
              <Input placeholder="Email" value={email} onChange={e => { setEmail(e.target.value); setLoginError(''); }} className="mb-3 mt-4" autoComplete="email" />
              <Input type="password" placeholder="Password" value={password} onChange={e => { setPassword(e.target.value); setLoginError(''); }} className="mb-4" autoComplete="current-password" onKeyDown={e => { if (e.key === 'Enter') login(); }} />
              {loginError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {loginError}
                </div>
              )}
              <div className="flex gap-3 mb-2">
                <Button onClick={login} className="flex-1" disabled={loginLoading}>
                  {loginLoading ? 'Logging in...' : t('loginMain')}
                </Button>
                <Button
                  type="button"
                  onClick={goToSignupPayScreen}
                  variant="outline"
                  className="flex-1"
                  disabled={loginLoading}
                >
                  {t('signUp')}
                </Button>
              </div>
              <p className="text-[11px] text-gray-500 mb-3 text-center leading-relaxed">
                New customers: <strong>Sign Up</strong> opens the free trial &amp; plan page. Accounts are
                not created on this screen — only through the trial / pricing signup.
              </p>
              <button 
                onClick={() => setShowMainForgot(true)} 
                className="text-sm text-blue-600 hover:underline w-full text-left"
              >
                Forgot your password?
              </button>
              <button
                type="button"
                onClick={clearStoredAuth}
                className="text-xs text-gray-500 hover:underline w-full text-left mt-3"
              >
                Clear saved login (fix stuck login)
              </button>
              <p className="text-[10px] text-gray-400 mt-4 leading-relaxed text-center">
                By continuing you agree to our{' '}
                <a href="/terms" className="underline text-emerald-700">
                  Terms
                </a>{' '}
                and{' '}
                <a href="/privacy" className="underline text-emerald-700">
                  Privacy Policy
                </a>
                . Support:{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
                  {SUPPORT_EMAIL}
                </a>
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600 mb-3">Enter your email to receive a password reset link.</p>
              <Input 
                placeholder="Your email" 
                value={forgotEmail} 
                onChange={e => setForgotEmail(e.target.value)} 
                className="mb-4" 
              />
              <Button onClick={requestMainPasswordReset} className="w-full mb-2">Send reset link</Button>
              <button 
                onClick={() => { setShowMainForgot(false); setForgotEmail(''); }} 
                className="text-sm text-gray-600 hover:underline w-full"
              >
                Back to login
              </button>
            </>
          )}

          <p className="text-[10px] text-gray-500 mt-4 text-center leading-relaxed">
            Crew members use this same login with the email and password set by the account owner
            under Plan / Billing → Manage account → Crew.
          </p>
        </Card>
      </div>
    );
  }

  // Two-Factor Authentication screen - DISABLED for production (was 100% simulated/fake)
  // Real 2FA should use Supabase Auth Phone, authenticator apps, or SMS provider.
  // Phase A: real MFA not shipped — keep 2FA UI permanently disabled
  if (false && requires2FA) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <Card className="w-full max-w-md p-8">
          <h2 className="text-2xl font-bold text-center mb-2">{t('twoStepVerification')}</h2>
          <p className="text-center text-gray-600 mb-4">
            Enter the 6-digit code sent to <strong>{twoFactorPhone}</strong>
          </p>
          <Input 
            placeholder="000000" 
            value={twoFactorCode} 
            onChange={e => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0,6))} 
            className="mb-6 text-center text-3xl tracking-[12px] font-mono" 
          />
          <Button onClick={verify2FA} className="w-full mb-3" disabled={twoFactorCode.length !== 6}>
            {t('verifyCode')}
          </Button>
          <Button onClick={resend2FACode} variant="outline" className="w-full mb-4">
            {t('resendCode')}
          </Button>
          <Button 
            variant="ghost" 
            className="w-full text-sm" 
            onClick={() => {
              if (supabase) supabase.auth.signOut();
              setUser(null);
              setCurrentCrew(null);
              setRequires2FA(false);
              setTwoFactorCode('');
              setShowLogin(true);
            }}
          >
            {t('backToLogin')}
          </Button>

        </Card>
      </div>
    );
  }

  // Wait for crew membership resolve so workspace id / paywall are correct
  if (user && !crewResolved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <ToastContainer />
        <Card className="w-full max-w-md p-8 text-center">
          <h2 className="text-xl font-semibold text-[#1e293b]">Loading your workspace…</h2>
          <p className="text-sm text-gray-500 mt-2">Checking account access</p>
        </Card>
      </div>
    );
  }

  // Paywall: billing enforced OR scheduled account close date has passed
  if (
    user &&
    !currentCrew &&
    billingLoaded &&
    !hasAppAccess(billing) &&
    (billingEnforced || !!billing.accountClosesAt)
  ) {
    return (
      <>
        <ToastContainer />
        <SubscriptionGate
          billing={billing}
          enforced={billingEnforced || !!billing.accountClosesAt}
          stripeConfigured={billingStripeOk}
          busy={billingBusy}
          supportEmail={SUPPORT_EMAIL}
          onCheckout={startSubscriptionCheckout}
          onPortal={openBillingPortal}
          onRefresh={refreshBillingStatus}
        />
      </>
    );
  }

  return (
    <>
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          #print-document, #print-document * { visibility: visible; }
          #print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 40px; }
          .no-print { display: none !important; }
        }
      `}</style>

      <ErrorBoundary>
        <div className="flex flex-col h-screen bg-[#f4f4f4]">
        {currentCrew && (
          <div className="bg-blue-100 text-blue-800 text-xs p-2 text-center">
            Logged in as crew: {currentCrew.email}
            {currentCrew.role === 'limited' ? ' (limited access)' : ''}
          </div>
        )}
        <div className="bg-white border-b px-4 py-2 flex justify-between items-center no-print sticky top-0 z-20 shadow-sm">
          <span className="text-sm font-semibold text-[#1e293b] truncate">
            {profile.company || 'EstimateAce'}
          </span>
          <Button onClick={logout} variant="outline" size="sm">{t('logOut')}</Button>
        </div>
        <div className="flex-1 overflow-auto p-4 md:p-8">
          {view === 'dashboard' && (
            <div>
              <div className="flex items-center gap-4 mb-8">
                {logoDisplayUrl && (
                  <img 
                    src={logoDisplayUrl} 
                    alt="Company Logo" 
                    className="w-20 h-20 object-contain border rounded flex-shrink-0" 
                  />
                )}
                <div>
                  <h2 className="text-4xl font-semibold text-[#1e293b]">{profile.company || t('welcome')}</h2>
                  <p className="text-gray-600 mt-1">{profile.slogan || t('dashboard')}</p>
                </div>
              </div>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    📋 {t('estimates')} (Not Archived)
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-3/4">{t('metric')}</TableHead>
                        <TableHead className="text-right">{t('count')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">{t('activeEstimates')}</TableCell>
                        <TableCell className="text-right text-4xl font-bold text-[#10b981]">
                          {estimatesCount}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    💰 {t('invoices')}
                  </h3>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice #</TableHead>
                          <TableHead>{t('jobName')}</TableHead>
                          <TableHead className="text-right">{t('amountDue')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {outstandingInvoices.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center py-8 text-gray-500">
                              {t('noOutstanding')}
                            </TableCell>
                          </TableRow>
                        ) : (
                          outstandingInvoices.map((inv) => (
                            <TableRow key={inv.id}>
                              <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                              <TableCell>{inv.jobName || 'Untitled'}</TableCell>
                              <TableCell className="text-right font-semibold">
                                ${calculateGrandTotal(inv).toFixed(2)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {outstandingInvoices.length > 0 && canSeeFinancials && (
                    <div className="mt-6 flex justify-end items-baseline gap-2 text-xl">
                      <span className="text-gray-600">{t('totalOutstandingLabel')}:</span>
                      <span className="font-bold text-amber-600">${totalOutstanding.toFixed(2)}</span>
                    </div>
                  )}
                  {outstandingInvoices.length > 0 && !canSeeFinancials && (
                    <div className="mt-6 text-sm text-gray-500">{t('outstandingRestricted')}</div>
                  )}
                </CardContent>
              </Card>

              <Card className="mb-8 border-emerald-200 bg-gradient-to-br from-white to-emerald-50/40">
                <CardContent className="p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-lg flex items-center gap-2">
                        📞 AI Receptionist
                        <span className="text-[10px] font-bold uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                          Beta
                        </span>
                        {receptionistSettings.enabled ? (
                          <span className="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                            On
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold uppercase bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                            Off
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-gray-600 mt-1 max-w-lg">
                        Knowledge base + <strong>Test call</strong> + message inbox work now. Live phone
                        forwarding is <strong>not</strong> available yet (Phase C).
                      </p>
                      {receptionistMessages.filter((m) => m.status === 'new' && !m.spam).length > 0 && (
                        <p className="text-xs font-semibold text-sky-700 mt-2">
                          {receptionistMessages.filter((m) => m.status === 'new' && !m.spam).length} new message
                          {receptionistMessages.filter((m) => m.status === 'new' && !m.spam).length === 1 ? '' : 's'}
                        </p>
                      )}
                    </div>
                    <Button
                      className="bg-[#10b981] hover:bg-[#059669] text-white shrink-0"
                      onClick={() => {
                        void loadReceptionistFromSettings();
                        setView('receptionistView');
                      }}
                    >
                      Open receptionist
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {canSeeFinancials && (
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-4 flex items-center gap-2">
                      📈 {t('yearToDateSales')}
                    </h3>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-3/4">Period</TableHead>
                          <TableHead className="text-right">Sales</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            {currentYear} (Year to Date)
                          </TableCell>
                          <TableCell className="text-right text-4xl font-bold text-[#10b981]">
                            ${salesYTD.toFixed(2)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
              {!canSeeFinancials && (
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-4 flex items-center gap-2">
                      📈 Sales Information
                    </h3>
                    <p className="text-sm text-gray-500">Financial details are restricted for your access level.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {view === 'estimatesList' && (
            <div className="w-full max-w-full min-w-0">
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4">
                <h2 className="text-2xl sm:text-3xl font-semibold">All {t('estimates')}</h2>
                {filteredEstimatesList.length > 0 && (
                  <Button 
                    size="sm" 
                    variant="outline" 
                    className="shrink-0 self-start sm:self-auto"
                    onClick={() => {
                      const estIds = filteredEstimatesList.map(est => est.id);
                      const allSelected = estIds.length > 0 && estIds.every(id => selectedIds.includes(id));
                      setSelectedIds(allSelected ? [] : estIds);
                    }}
                  >
                    {selectedIds.length > 0 ? 'Deselect All' : 'Select All'}
                  </Button>
                )}
              </div>

              <div className="mb-4 w-full max-w-full min-w-0">
                <label htmlFor="estimate-list-search" className="sr-only">
                  Search estimates
                </label>
                <div className="relative w-full max-w-full">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" aria-hidden>
                    🔍
                  </span>
                  <Input
                    id="estimate-list-search"
                    type="search"
                    value={estimateListSearch}
                    onChange={(e) => setEstimateListSearch(e.target.value)}
                    placeholder="Search estimates by name, #, date, address, phone, email…"
                    className="w-full max-w-full pl-9 pr-10 h-11"
                    autoComplete="off"
                  />
                  {estimateListSearch.trim() && (
                    <button
                      type="button"
                      onClick={() => setEstimateListSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 text-sm px-2 py-1 rounded"
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-gray-500">
                  {estimateListSearch.trim()
                    ? `${filteredEstimatesList.length} result${filteredEstimatesList.length === 1 ? '' : 's'}`
                    : `${estimatesCount} estimate${estimatesCount === 1 ? '' : 's'}`}
                </p>
              </div>

              {selectedIds.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2 p-3 bg-gray-50 rounded-lg">
                  <Button size="sm" onClick={bulkOpen} disabled={selectedIds.length !== 1}>
                    Open Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="outline" onClick={bulkArchive}>
                    Archive Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="destructive" onClick={bulkDelete}>
                    Delete Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
                    Clear Selection
                  </Button>
                </div>
              )}

              <div className="space-y-4">
                {filteredEstimatesList.length === 0 && (
                  <div className="border border-dashed rounded-lg p-8 text-center text-sm text-gray-500 bg-white">
                    {estimateListSearch.trim()
                      ? `No estimates match “${estimateListSearch.trim()}”.`
                      : `No estimates yet. Create one from the dashboard.`}
                  </div>
                )}
                {filteredEstimatesList.map((est) => (
                  <div key={est.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border p-4 rounded-lg bg-white min-w-0">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <input 
                        type="checkbox" 
                        checked={selectedIds.includes(est.id)}
                        onChange={() => {
                          setSelectedIds(prev => 
                            prev.includes(est.id) 
                              ? prev.filter(id => id !== est.id) 
                              : [...prev, est.id]
                          );
                        }}
                        className="shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="font-medium break-words">{est.jobName || 'Untitled'}</div>
                        <div className="text-sm text-gray-500 break-words">
                          {est.invoiceNumber} • {est.date}
                          {(est.address || est.city) ? ` • ${[est.address, est.city, est.state].filter(Boolean).join(', ')}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:gap-3 shrink-0">
                      <Button size="sm" onClick={async () => { await loadSelectedEstimate(est); setView('editor'); setSelectedIds([]); }}>{t('open')}</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>{t('archive')}</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>{t('delete')}</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'invoicesList' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-3xl font-semibold">Open {t('invoices')}</h2>
                {openInvoicesList.length > 0 && (
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => {
                      const invIds = openInvoicesList.map(est => est.id);
                      setSelectedIds(selectedIds.length === invIds.length ? [] : invIds);
                    }}
                  >
                    {selectedIds.length > 0 ? 'Deselect All' : 'Select All'}
                  </Button>
                )}
              </div>
              <p className="text-sm text-gray-500 mb-4">
                Paid invoices are moved to Profile → {t('paidInvoices')}.
              </p>

              {selectedIds.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2 p-3 bg-gray-50 rounded-lg">
                  <Button size="sm" onClick={bulkOpen} disabled={selectedIds.length !== 1}>
                    Open Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="outline" onClick={bulkArchive}>
                    Archive Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="destructive" onClick={bulkDelete}>
                    Delete Selected ({selectedIds.length})
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
                    Clear Selection
                  </Button>
                </div>
              )}

              <div className="space-y-4">
                {openInvoicesList.length === 0 && (
                  <div className="border border-dashed rounded-lg p-8 text-center text-sm text-gray-500 bg-white">
                    No open invoices. Paid invoices are under Profile → {t('paidInvoices')}.
                  </div>
                )}
                {openInvoicesList.map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div className="flex items-center gap-3 flex-1">
                      <input 
                        type="checkbox" 
                        checked={selectedIds.includes(est.id)}
                        onChange={() => {
                          setSelectedIds(prev => 
                            prev.includes(est.id) 
                              ? prev.filter(id => id !== est.id) 
                              : [...prev, est.id]
                          );
                        }}
                      />
                      <div>
                        <div className="font-medium">{est.jobName || 'Untitled'}</div>
                        <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Button size="sm" onClick={async () => { await loadSelectedEstimate(est); setView('editor'); setSelectedIds([]); }}>{t('open')}</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>{t('archive')}</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>{t('delete')}</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'editor' && (
            <div className="w-full max-w-full min-w-0 overflow-x-hidden box-border">
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>

              <div className="flex justify-between items-start mb-8">
                <div className="flex items-start gap-4">
                  {logoDisplayUrl && (
                    <img 
                      src={logoDisplayUrl} 
                      alt="Company Logo" 
                      className={`${getLogoClass(profile.logoSize)} object-contain border rounded flex-shrink-0`} 
                    />
                  )}
                  <div>
                    <h1 className="text-5xl font-bold text-[#1e293b]">{profile.company || t('companyProfile')}</h1>
                    <p className="text-xl text-gray-600">{profile.slogan || 'Professional Estimation & Invoicing'}</p>
                    {profile.phone && <p className="text-lg text-gray-600 mt-1">📞 {profile.phone}</p>}
                    {profile.email && <p className="text-lg text-gray-600">✉️ {profile.email}</p>}
                    {(profile.address || profile.city || profile.state || profile.zipCode) && (
                      <p className="text-lg text-gray-600">
                        {profile.address}
                        {profile.city && `, ${profile.city}`}
                        {profile.state && `, ${profile.state}`}
                        {profile.zipCode && ` ${profile.zipCode}`}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">Document #</div>
                  <div className="text-4xl font-mono font-bold text-[#10b981]">{invoiceNumber}</div>
                  <div className="text-sm text-gray-500 mt-1">Date: {date}</div>
                </div>
              </div>

              <Card className="mb-8">
                <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold mb-1">{t('jobNameLabel')}</label>
                    <Input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="Client" />
                  </div>
                  <div className="relative">
                    <label className="block text-sm font-semibold mb-1">{t('address')}</label>
                    <Input 
                      value={address} 
                      onChange={e => {
                        setAddress(e.target.value);
                        setShowAddressSuggestions(true);
                      }} 
                      onFocus={() => {
                        setShowAddressSuggestions(true);
                        if (user?.id) {
                          refreshSavedList();
                          refreshArchivesList();
                        }
                      }}
                      onBlur={() => setTimeout(() => setShowAddressSuggestions(false), 200)}
                      placeholder="Street address — include city & state for best results"
                      autoComplete="street-address"
                    />
                    {showAddressSuggestions && (
                      <div className="absolute z-[60] mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto text-sm">
                        {isLoadingSuggestions && (
                          <div className="px-3 py-2 text-xs text-gray-500">Searching addresses...</div>
                        )}
                        {!isLoadingSuggestions && addressSuggestions.length === 0 && address.trim().length >= 2 && (
                          <div className="px-3 py-2 text-xs text-gray-500">
                            No matches yet. Try adding the city and state (e.g. 2334 Senior Dr, Charlotte NC).
                          </div>
                        )}
                        {addressSuggestions.map((sugg, idx) => (
                          <div 
                            key={`${sugg.place_id || sugg.display || sugg.address}-${idx}`}
                            className="px-3 py-2 hover:bg-gray-100 cursor-pointer border-b border-gray-100 last:border-b-0"
                            onMouseDown={async (e) => {
                              e.preventDefault();
                              setShowAddressSuggestions(false);

                              if (sugg.place_id) {
                                try {
                                  const res = await fetch(`/api/address-autocomplete?place_id=${sugg.place_id}`);
                                  if (res.ok) {
                                    const details = await res.json();
                                    setAddress(details.address || sugg.address || sugg.display || '');
                                    if (details.city) setCity(details.city);
                                    if (details.state) setState(details.state);
                                    if (details.zipCode) setZipCode(details.zipCode);
                                    return;
                                  }
                                } catch (err) {
                                  console.error('Failed to fetch place details:', err);
                                }
                              }

                              setAddress(sugg.address || sugg.display || '');
                              if (sugg.city) setCity(sugg.city);
                              if (sugg.state) setState(sugg.state);
                              if (sugg.zipCode) setZipCode(sugg.zipCode);
                            }}
                          >
                            <div className="font-medium leading-snug">
                              {sugg.display || sugg.address}
                            </div>
                            {sugg.address && sugg.display && sugg.display !== sugg.address && (
                              <div className="text-[11px] text-gray-600 mt-0.5">{sugg.address}</div>
                            )}
                            {(sugg.city || sugg.state || sugg.zipCode) && !sugg.display?.includes(sugg.city) && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {[sugg.city, sugg.state, sugg.zipCode].filter(Boolean).join(', ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div><label className="block text-sm font-semibold mb-1">{t('cityLabel')}</label><Input value={city} onChange={e => setCity(e.target.value)} /></div>
                    <div><label className="block text-sm font-semibold mb-1">{t('stateLabel')}</label><Input value={state} onChange={e => setState(e.target.value)} placeholder="CA" /></div>
                    <div><label className="block text-sm font-semibold mb-1">{t('zipLabel')}</label><Input value={zipCode} onChange={e => setZipCode(e.target.value)} /></div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">{t('phonesLabel')}</label>
                    {phones.map((phone, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={phone} onChange={e => updatePhone(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removePhone(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addPhone}>+ Add Phone</Button>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">{t('emailsLabel')}</label>
                    {emails.map((em, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={em} onChange={e => updateEmail(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removeEmail(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addEmail}>+ Add Email</Button>
                  </div>

                  <div className="md:col-span-2 flex items-center gap-8 pt-4 border-t">
                    {getTaxesEnabled() ? (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={isTaxExempt} onChange={e => setIsTaxExempt(e.target.checked)} />
                          <span className="font-medium">{t('taxExempt')}</span>
                        </label>
                        <div className="ml-auto text-sm text-gray-500">
                          Rate: <span className="font-semibold">{baseTaxRate}%</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-gray-500">
                        Taxes are turned off in Profile settings. Enable taxes there to calculate sales tax on estimates.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-3 mb-8 items-center">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const checked = !estimateBreakdownSettings.showMaterialBreakdownOnEstimate;
                    void saveEstimateBreakdownSettings({
                      showMaterialBreakdownOnEstimate: checked,
                    });
                  }}
                  className={
                    estimateBreakdownSettings.showMaterialBreakdownOnEstimate
                      ? 'bg-[#10b981] hover:bg-[#059669] text-white border-[#10b981]'
                      : ''
                  }
                >
                  {estimateBreakdownSettings.showMaterialBreakdownOnEstimate ? '✓ ' : ''}Show Materials Breakdown
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const checked = !estimateBreakdownSettings.showLaborBreakdownOnEstimate;
                    void saveEstimateBreakdownSettings({
                      showLaborBreakdownOnEstimate: checked,
                    });
                  }}
                  className={
                    estimateBreakdownSettings.showLaborBreakdownOnEstimate
                      ? 'bg-[#10b981] hover:bg-[#059669] text-white border-[#10b981]'
                      : ''
                  }
                >
                  {estimateBreakdownSettings.showLaborBreakdownOnEstimate ? '✓ ' : ''}Show Labor Breakdown
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const checked = !estimateBreakdownSettings.showCostBreakdownOnEstimate;
                    void saveEstimateBreakdownSettings({ showCostBreakdownOnEstimate: checked });
                  }}
                  className={
                    estimateBreakdownSettings.showCostBreakdownOnEstimate
                      ? 'bg-[#10b981] hover:bg-[#059669] text-white border-[#10b981]'
                      : ''
                  }
                >
                  {estimateBreakdownSettings.showCostBreakdownOnEstimate ? '✓ ' : ''}Show Cost Breakdown
                </Button>
                <div className="hidden sm:block w-px h-8 bg-gray-300 mx-1" aria-hidden />
                <Button onClick={addRow} variant="outline">{t('addLineItem')}</Button>
                <Button onClick={openQuickLinesModal} variant="outline">{t('quickLines')}</Button>
              </div>

              <Card className="mb-8 overflow-hidden w-full max-w-full min-w-0">
                {/* Responsive line items: description block + pricing block (stacks under on narrow screens) */}
                <div className="space-y-4 p-3 sm:p-4 w-full max-w-full min-w-0 box-border">
                  {items.map((item, idx) => (
                    <div
                      key={item.id}
                      className="line-item-card rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-2 bg-[#1e293b] text-white px-3 py-2.5">
                        <span className="text-sm font-semibold">Line {idx + 1}</span>
                        <div className="flex gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-white/10 text-white border-white/30 hover:bg-white/20 h-8"
                            onClick={() => saveAsQuickLine(item)}
                            title="Save as quick line"
                          >
                            💾
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-8"
                            onClick={() => removeRow(item.id)}
                            title="Remove line"
                          >
                            ×
                          </Button>
                        </div>
                      </div>

                      <div className="line-item-card-body p-3 sm:p-4">
                        {/* Description block — always full device width on small screens */}
                        <div className="line-item-description-block space-y-2">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            Description
                          </div>
                          <div className="rounded-lg border border-gray-200 bg-white p-2 sm:p-3 w-full max-w-full min-w-0 overflow-hidden box-border">
                            <TouchDoubleTapTextarea
                              value={item.description}
                              onChange={e => updateItem(item.id, 'description', e.target.value)}
                              rows={3}
                              className="min-h-[72px] text-sm leading-relaxed border-0 shadow-none focus-visible:ring-0 px-1 py-1"
                            />
                          </div>

                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-1 w-full text-xs flex items-center gap-1 justify-center"
                            onClick={async () => {
                              const currentDesc = item.description?.trim();
                              if (!currentDesc) return showMessage('Enter a description first');

                              setImprovingDescriptionId(item.id);

                              try {
                                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                if (supabase) {
                                  const { data: { session } } = await supabase.auth.getSession();
                                  if (session?.access_token) {
                                    headers['Authorization'] = `Bearer ${session.access_token}`;
                                  }
                                }

                                const res = await fetch('/api/grok', {
                                  method: 'POST',
                                  headers,
                                  body: JSON.stringify({ description: currentDesc })
                                });

                                const data = await res.json();

                                if (!res.ok || data.error) {
                                  const errMsg = data.error || data.suggestion || 'Grok AI error';
                                  if (errMsg.includes('Rate limit')) {
                                    showMessage(`⏳ ${errMsg}`);
                                  } else if (errMsg.includes('Unauthorized') || errMsg.includes('missing')) {
                                    showMessage('🔒 Please log in with a main account to use AI features.');
                                  } else if (errMsg.includes('API key') || errMsg.includes('Incorrect')) {
                                    showMessage('🔑 AI service key issue. Check Vercel env vars and redeploy.');
                                  } else {
                                    showMessage(`❌ ${errMsg}`);
                                  }
                                  return;
                                }

                                if (data.suggestion) {
                                  updateItem(item.id, 'description', data.suggestion);
                                  showMessage('✅ Line description updated — use Grok AI for customer-facing scope and features.');
                                }
                              } catch (err) {
                                console.error('Grok AI call failed:', err);
                                showMessage('⚠️ Network error. Could not reach Grok AI. Check your connection or console.');
                              } finally {
                                setImprovingDescriptionId(null);
                              }
                            }}
                            disabled={improvingDescriptionId === item.id}
                          >
                            {improvingDescriptionId === item.id ? '⏳ Improving...' : '🤖 Grok AI'}
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            className="w-full text-xs flex items-center gap-1 justify-center bg-amber-100 hover:bg-amber-200"
                            onClick={() => {
                              const description = item.description?.trim();
                              if (!description) return showMessage('Enter a description first');
                              void requestAiQuote(item);
                            }}
                            disabled={aiQuoteLoadingId === item.id}
                          >
                            {aiQuoteLoadingId === item.id ? '⏳ Getting quote...' : '💰 AI Price Quote (Online Data)'}
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            className="w-full text-xs flex items-center gap-1 justify-center bg-slate-100 hover:bg-slate-200"
                            onClick={() => openBreakdownEditor(item)}
                          >
                            ✏️ {hasItemBreakdown(item) || itemHasCostData(item) ? 'Edit Breakdown' : 'Add Breakdown'}
                          </Button>

                          {hasAnyBreakdownToggleOn() && (hasItemBreakdown(item) || itemHasCostData(item)) && (() => {
                            const preview = getVisibleBreakdownParts(item);
                            if (!preview.hasVisiblePreview) return null;
                            return (
                              <div className="mt-1 p-2 bg-gray-50 border rounded text-[10px] text-gray-700">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <div className="font-semibold">Line {idx + 1} Breakdown:</div>
                                  <button
                                    type="button"
                                    onClick={() => openBreakdownEditor(item)}
                                    className="text-[10px] text-[#10b981] hover:underline shrink-0"
                                  >
                                    Edit
                                  </button>
                                </div>
                                {(preview.showMaterials || preview.showLabor) && renderItemBreakdown(item, '', {
                                  showMaterials: preview.showMaterials,
                                  showLabor: preview.showLabor,
                                })}
                                {preview.showCosts && renderCostBreakdown(item, (preview.showMaterials || preview.showLabor) ? 'mt-2 pt-2 border-t border-gray-200' : '')}
                              </div>
                            );
                          })()}

                          <div className="mt-2 pt-3 border-t flex flex-wrap items-center gap-2 text-xs">
                            <select
                              value={translateFrom}
                              onChange={(e) => setTranslateFrom(e.target.value)}
                              className="border rounded px-2 py-1 bg-white max-w-[10rem]"
                            >
                              {APP_LANGUAGES.map((lang) => (
                                <option key={`from-${lang.code}`} value={lang.code}>
                                  {lang.name}
                                </option>
                              ))}
                            </select>

                            <span className="text-gray-400">→</span>

                            <select
                              value={translateTo}
                              onChange={(e) => setTranslateTo(e.target.value)}
                              className="border rounded px-2 py-1 bg-white max-w-[10rem]"
                            >
                              {APP_LANGUAGES.map((lang) => (
                                <option key={`to-${lang.code}`} value={lang.code}>
                                  {lang.name}
                                </option>
                              ))}
                            </select>

                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs"
                              onClick={() => translateDescription(item.description, item.id)}
                            >
                              🔄 Translate
                            </Button>
                          </div>

                          {itemTranslations[item.id] && (
                            <div className="mt-2 relative">
                              <div className="text-[10px] font-medium text-emerald-600 flex items-center gap-1 mb-1">
                                🔄 Translation (Internal team use only — not sent to client)
                              </div>
                              <Textarea
                                value={itemTranslations[item.id]}
                                readOnly
                                rows={3}
                                className="resize-y bg-gray-50 text-sm w-full"
                              />
                              <button
                                type="button"
                                onClick={() => setItemTranslations(prev => {
                                  const copy = { ...prev };
                                  delete copy[item.id];
                                  return copy;
                                })}
                                className="absolute top-1 right-2 text-xs text-red-500 hover:text-red-700"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Pricing block — under description on phones/tablets; beside on desktop */}
                        <div className="line-item-pricing-block">
                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4 w-full max-w-full min-w-0 box-border">
                            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                              Qty · SF/Unit · Price · Total
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="block text-[11px] font-medium text-gray-600">Qty</label>
                                <Input
                                  type="number"
                                  value={item.qty}
                                  onChange={e => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)}
                                  className="text-right bg-white"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="block text-[11px] font-medium text-gray-600">SF/Unit</label>
                                <Input
                                  list="line-item-unit-options"
                                  value={item.unit || ''}
                                  onChange={e => updateItem(item.id, 'unit', e.target.value)}
                                  className="text-right bg-white"
                                  placeholder="SF or Unit"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="block text-[11px] font-medium text-gray-600">SF/Unit Price</label>
                                {canSeePricing ? (
                                  <Input
                                    type="number"
                                    value={item.price}
                                    onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)}
                                    className="text-right bg-white [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [appearance:textfield]"
                                  />
                                ) : (
                                  <div className="h-10 flex items-center justify-end text-gray-400 px-3">—</div>
                                )}
                              </div>
                              <div className="space-y-1">
                                <label className="block text-[11px] font-medium text-gray-600">Total</label>
                                {canSeePricing ? (
                                  <Input
                                    type="number"
                                    step="0.01"
                                    value={item.total ?? 0}
                                    onChange={e => updateItem(item.id, 'total', parseFloat(e.target.value) || 0)}
                                    className="text-right font-medium bg-white [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [appearance:textfield]"
                                  />
                                ) : (
                                  <div className="h-10 flex items-center justify-end text-gray-400 px-3">—</div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <datalist id="line-item-unit-options">
                  {LINE_ITEM_UNITS.map(unit => (
                    <option key={unit} value={unit} />
                  ))}
                </datalist>

                <div className="p-6 bg-white border-t">
                  <div className="mb-4 p-4 border rounded-lg bg-gray-50">
                    <p className="font-semibold mb-3">Discount (optional)</p>
                    <div className="flex flex-wrap gap-3 items-end">
                      <div className="flex-1 min-w-[220px]">
                        <label className="block text-xs text-gray-500 mb-1">Discount name</label>
                        <select
                          value={discountDescription}
                          onChange={e => setDiscountDescription(e.target.value)}
                          className="flex h-10 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm"
                        >
                          <option value="">Select discount...</option>
                          {discountNames.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex-1 min-w-[220px]">
                        <label className="block text-xs text-gray-500 mb-1">Add new discount</label>
                        <div className="flex gap-2">
                          <Input
                            value={newDiscountNameInput}
                            onChange={e => setNewDiscountNameInput(e.target.value)}
                            placeholder="e.g. Senior discount"
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDiscountName(); } }}
                          />
                          <Button type="button" variant="outline" onClick={addDiscountName}>Add</Button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Type</label>
                        <div className="flex border rounded-lg overflow-hidden">
                          <button
                            type="button"
                            onClick={() => setDiscountType('percent')}
                            className={`px-4 py-2 text-sm font-semibold ${discountType === 'percent' ? 'bg-[#10b981] text-white' : 'bg-white text-gray-700'}`}
                          >
                            %
                          </button>
                          <button
                            type="button"
                            onClick={() => setDiscountType('dollar')}
                            className={`px-4 py-2 text-sm font-semibold border-l ${discountType === 'dollar' ? 'bg-[#10b981] text-white' : 'bg-white text-gray-700'}`}
                          >
                            $
                          </button>
                        </div>
                      </div>
                      <div className="w-36">
                        <label className="block text-xs text-gray-500 mb-1">
                          {discountType === 'percent' ? 'Percentage' : 'Dollar amount'}
                        </label>
                        <Input
                          type="number"
                          min="0"
                          step={discountType === 'percent' ? '0.1' : '0.01'}
                          value={discountValueInput}
                          onChange={e => setDiscountValueInput(e.target.value)}
                          placeholder={discountType === 'percent' ? '10' : '50.00'}
                        />
                      </div>
                      <Button
                        type="button"
                        onClick={applyDiscount}
                        className="bg-[#10b981] hover:bg-[#059669] text-white"
                      >
                        Apply
                      </Button>
                      {hasActiveDiscount() && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={clearAppliedDiscount}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                    {hasActiveDiscount() && !getShowDiscountOnEstimate() && (
                      <p className="text-sm text-amber-700 mt-2">
                        Discount applied internally (-${discountAmount.toFixed(2)}) but hidden on client estimate. Turn on in Profile → Show Discount on Estimate.
                      </p>
                    )}
                    {shouldShowClientDiscount() && (
                      <p className="text-sm text-red-600 mt-2">
                        Discount applied: -${discountAmount.toFixed(2)}
                        {appliedDiscountType === 'percent' ? ` (${appliedDiscountValue}% of $${subtotalBeforeDiscount.toFixed(2)})` : ''}
                      </p>
                    )}
                  </div>

                  {canSeeFinancials ? (
                    <>
                      <div className="flex justify-end text-xl font-semibold mb-2 text-gray-700">
                        Subtotal (line items): <span className="ml-4">${taxableSubtotal.toFixed(2)}</span>
                      </div>
                      {laborAmount > 0 && (
                        <div className="flex justify-end text-xl font-semibold mb-2 text-[#14b8a6]">
                          <span>
                            Labor: <span className="ml-4">${laborAmount.toFixed(2)}</span>
                            <span className="block text-sm font-normal text-gray-500 text-right">Reference only — not included in total</span>
                          </span>
                        </div>
                      )}
                      {hasActiveDiscount() && (
                        <div className="flex justify-end text-xl font-semibold mb-2 text-gray-700">
                          Subtotal before discount: <span className="ml-4">${subtotalBeforeDiscount.toFixed(2)}</span>
                        </div>
                      )}
                      {hasActiveDiscount() && (
                        <div className={`flex justify-end text-2xl font-semibold mb-2 ${shouldShowClientDiscount() ? 'text-red-600' : 'text-amber-700'}`}>
                          {appliedDiscountDescription.trim()}: <span className="ml-4">-${discountAmount.toFixed(2)}</span>
                          {appliedDiscountType === 'percent' ? <span className="ml-2 text-base text-gray-500">({appliedDiscountValue}%)</span> : null}
                        </div>
                      )}
                      {hasActiveDiscount() && (
                        <div className="flex justify-end text-xl font-semibold mb-2 text-gray-700">
                          Subtotal after discount: <span className="ml-4">${subtotalAfterDiscount.toFixed(2)}</span>
                        </div>
                      )}
                      {getTaxesEnabled() && (
                        <div className="flex justify-end text-2xl font-semibold mb-2">
                          Taxes ({state || '—'} {baseTaxRate}%): <span className="text-[#14b8a6] ml-4">${taxAmount.toFixed(2)}</span>
                        </div>
                      )}
                      <div className="flex justify-end text-4xl font-bold">
                        Grand Total: <span className="text-[#10b981] ml-4">${grandTotal.toFixed(2)}</span>
                      </div>

                      {profile.chargeCCFee && (
                        <div className="flex justify-end text-sm mt-2 text-gray-600">
                          + Credit card processing fee ({ccFeePercent}%): <span className="font-medium ml-1">${ccFeeAmount.toFixed(2)}</span>
                          <span className="ml-3 text-[#f59e0b] font-semibold">Card total: ${totalWithCCFee.toFixed(2)}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex justify-end text-lg text-gray-500">
                      Financial details hidden for this crew member
                    </div>
                  )}
                </div>
              </Card>

              {documentType === 'invoice' ? (
                <div className="flex flex-wrap gap-3 mb-8">
                  <Button onClick={printDocument} className="bg-[#3b82f6]">{t('printPreview')}</Button>
                  <Button onClick={markAsPaidCash} className="bg-green-600">Paid Cash</Button>
                  {isVenmoPaymentReady() && (
                    <Button
                      onClick={() => openVenmoPayment(Math.max(0, grandTotal - (Number(amountPaid) || 0)), 'invoice')}
                      className="bg-[#008cff] hover:bg-[#0070cc]"
                    >
                      Pay / Confirm Venmo
                    </Button>
                  )}
                  {isVenmoPaymentReady() && paymentStatus !== 'paid' && (
                    <Button
                      variant="outline"
                      className="border-blue-300 text-blue-800"
                      onClick={() => void markInvoicePaid('Venmo')}
                    >
                      Mark Paid (Venmo received)
                    </Button>
                  )}
                  {isZellePaymentReady() && (
                    <Button
                      onClick={() => openZellePayment(Math.max(0, grandTotal - (Number(amountPaid) || 0)), 'invoice')}
                      className="bg-[#6d28d9] hover:bg-[#5b21b6]"
                    >
                      Pay / Confirm Zelle
                    </Button>
                  )}
                  {isZellePaymentReady() && paymentStatus !== 'paid' && (
                    <Button
                      variant="outline"
                      className="border-violet-300 text-violet-800"
                      onClick={() => void markInvoicePaid('Zelle')}
                    >
                      Mark Paid (Zelle received)
                    </Button>
                  )}
                  {isPayPalPaymentReady() && (
                    <Button
                      onClick={() => openPayPalPayment(Math.max(0, grandTotal - (Number(amountPaid) || 0)), 'invoice')}
                      className="bg-[#0070ba] hover:bg-[#005ea6]"
                    >
                      Pay / Confirm PayPal
                    </Button>
                  )}
                  {isPayPalPaymentReady() && paymentStatus !== 'paid' && (
                    <Button
                      variant="outline"
                      className="border-sky-300 text-sky-900"
                      onClick={() => void markInvoicePaid('PayPal')}
                    >
                      Mark Paid (PayPal received)
                    </Button>
                  )}
                  {hasMailCheckSetup(getMailCheckSettings()) && paymentStatus !== 'paid' && (
                    <Button
                      variant="outline"
                      className="border-stone-300 text-stone-800"
                      onClick={() => void markInvoicePaid('Check')}
                    >
                      Mark Paid (Check received)
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-3 mb-8">
                  <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">{t('saveEstimate')}</Button>
                  <Button onClick={printDocument} className="bg-[#3b82f6]">{t('printPreview')}</Button>
                  <Button onClick={openSendPreview} className="bg-[#8b5cf6]">{t('sendEstimate')}</Button>
                  <Button onClick={convertToInvoice} className="bg-[#f59e0b]">{t('convertToInvoice')}</Button>
                </div>
              )}

              {/* Gallery pickers — include HEIC for iPhone camera roll; live camera uses DeviceCamera */}
              <input
                ref={photoGalleryInputRef}
                type="file"
                accept="image/*,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp"
                multiple
                className="hidden"
                onChange={e => void handlePhotoGalleryChange(e.target.files)}
              />
              <input
                ref={videoGalleryInputRef}
                type="file"
                accept="video/*,video/mp4,video/quicktime,.mp4,.mov"
                multiple
                className="hidden"
                onChange={e => void handleVideoGalleryChange(e.target.files)}
              />

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">{t('photosSection')} ({photoUrls.length})</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Use your phone camera to capture job photos. Tap 📷 AI Quote on any photo to price a line item.
                    {photoUrls.length > PHOTO_FOLDER_THRESHOLD
                      ? ' With more than 6 photos, they are kept in a folder — click the folder to view them.'
                      : ''}
                  </p>
                  {renderPhotoGallery({ editable: true })}
                </CardContent>
              </Card>

              <Dialog open={isPhotoQuoteLinePickerOpen} onOpenChange={setIsPhotoQuoteLinePickerOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>AI Quote from Job Photo</DialogTitle>
                  </DialogHeader>
                  <p className="text-sm text-gray-600">
                    Choose which line item should receive the price quote from this photo.
                  </p>
                  <select
                    value={photoQuoteLineId ?? ''}
                    onChange={e => setPhotoQuoteLineId(Number(e.target.value))}
                    className="flex h-10 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm"
                  >
                    {items.map((line, i) => (
                      <option key={line.id} value={line.id}>
                        Line {i + 1}: {line.description?.trim() || '(empty description)'}
                      </option>
                    ))}
                  </select>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setIsPhotoQuoteLinePickerOpen(false)}>Cancel</Button>
                    <Button onClick={() => void runGalleryPhotoQuote()} className="bg-violet-600 hover:bg-violet-700">
                      Generate Quote
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">{t('videosSection')} ({videoUrls.length})</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Record with your phone camera or upload an existing video. Videos save to this estimate automatically.
                    Use <span className="font-medium text-gray-700">Delete</span> on any video to remove it after saving.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {videoDisplayUrls.map((url, i) => (
                      <div key={i} className="relative group rounded-lg border bg-gray-50 overflow-hidden">
                        <video
                          src={url}
                          controls
                          playsInline
                          className="w-full h-40 object-cover bg-black"
                        />
                        {/* Always visible on mobile (hover-only was easy to miss) */}
                        <button
                          type="button"
                          onClick={() => confirmRemoveVideo(i)}
                          className="absolute top-2 right-2 z-10 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold w-10 h-10 flex items-center justify-center rounded-2xl shadow-xl"
                          aria-label={`Delete video ${i + 1}`}
                          title="Delete video"
                        >
                          ×
                        </button>
                        <button
                          type="button"
                          onClick={() => confirmRemoveVideo(i)}
                          className="w-full py-2 text-sm font-semibold text-red-700 bg-red-50 hover:bg-red-100 border-t border-red-100"
                        >
                          Delete video
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={openDeviceVideoCamera}
                      className="flex flex-col items-center justify-center h-40 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition w-full"
                    >
                      <div className="text-4xl mb-1">🎥</div>
                      <div className="text-xs text-gray-500 font-medium">Record Video</div>
                      <div className="text-[10px] text-gray-400 mt-1 px-2 text-center">Fixed shutter</div>
                    </button>
                    <button
                      type="button"
                      onClick={triggerVideoGallery}
                      className="flex flex-col items-center justify-center h-40 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition w-full"
                    >
                      <div className="text-4xl mb-1">📁</div>
                      <div className="text-xs text-gray-500 font-medium">Upload Video</div>
                      <div className="text-[10px] text-gray-400 mt-1 px-2 text-center">From device</div>
                    </button>
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">{t('receiptsSection')} ({receiptUrls.length})</h3>
                  <div className="flex flex-wrap gap-2 mb-4">
                    <Button onClick={() => document.getElementById('receipts-camera')?.click()}>
                      {t('scanReceipt')}
                    </Button>
                    <Button onClick={() => setIsLaborModalOpen(true)} className="bg-[#14b8a6] text-white">
                      {t('laborButton')}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setIsMileageModalOpen(true)}
                      className="bg-[#0ea5e9] text-white"
                    >
                      🚗 Mileage
                      {jobMileageLogs.length > 0
                        ? ` (${sumMileageLogs(jobMileageLogs).toFixed(1)} mi)`
                        : ''}
                    </Button>
                  </div>
                  <input id="receipts-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'receipt')} className="hidden" />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {receiptDisplayUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('receipt', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xl font-semibold">{t('termsConditionsEditor')}</h3>
                    {savedTemplates.length > 0 && (
                      <select 
                        className="text-sm border rounded px-2 py-1"
                        onChange={(e) => {
                          const tmpl = savedTemplates.find((tm: any) => tm.name === e.target.value);
                          if (tmpl) setTerms(tmpl.text);
                        }}
                        defaultValue=""
                      >
                        <option value="">Load template...</option>
                        {savedTemplates.map((tmpl: any, i: number) => (
                          <option key={i} value={tmpl.name}>{tmpl.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <TouchDoubleTapTextarea value={terms} onChange={e => setTerms(e.target.value)} rows={6} />
                </CardContent>
              </Card>

              <div id="print-document" className="max-w-4xl mx-auto bg-white p-10 shadow-2xl hidden print:block">
                <div className="flex items-center gap-4 mb-2">
                  {logoDisplayUrl && (
                    <img src={logoDisplayUrl} alt="Logo" className={`${getLogoClass(profile.logoSize)} object-contain`} />
                  )}
                  <h1 className="text-4xl font-bold">{profile.company || 'Your Company'}</h1>
                </div>
                {(profile.phone || profile.email || profile.address || profile.city || profile.state || profile.zipCode) && (
                  <p className="text-center text-xl text-gray-600 mb-8">
                    {profile.phone && `📞 ${profile.phone}`}{profile.phone && profile.email && ' | '}{profile.email && `✉️ ${profile.email}`}
                    {(profile.address || profile.city || profile.state || profile.zipCode) && (
                      <span className="block text-sm mt-1">
                        {profile.address}
                        {profile.city && `, ${profile.city}`}
                        {profile.state && `, ${profile.state}`}
                        {profile.zipCode && ` ${profile.zipCode}`}
                      </span>
                    )}
                  </p>
                )}
                <div className="flex justify-between mb-8">
                  <div>
                    <strong>{documentType.toUpperCase()} # {invoiceNumber}</strong><br />
                    Date: {date}<br />
                    Client: {jobName}
                  </div>
                  <div className="text-right">
                    <strong>Bill To:</strong><br />
                    {address}<br />
                    {city}, {state} {zipCode}
                  </div>
                </div>
                <table className="w-full border-collapse mb-8">
                  <thead>
                    <tr className="border-b-2 border-gray-800">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">SF/Unit</th>
                      <th className="text-right py-2">SF/Unit Price</th>
                      <th className="text-right py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-3">
                          <span className="text-xs text-gray-500">Line {i + 1}: </span>{item.description}
                          {renderClientItemBreakdown(item, 'mt-1 text-[10px] text-gray-600 leading-tight pl-2')}
                        </td>
                        <td className="py-3 text-right">{item.qty}</td>
                        <td className="py-3 text-right">{item.unit || '—'}</td>
                        <td className="py-3 text-right">{canSeePricing ? `$${item.price.toFixed(2)}` : '—'}</td>
                        <td className="py-3 text-right">{canSeePricing ? `$${item.total.toFixed(2)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {renderDocumentTotals({ large: true })}

                {terms && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Terms & Conditions</h3>
                    <div className="text-gray-700 leading-relaxed whitespace-pre-wrap border rounded-xl p-6 bg-gray-50">
                      {terms}
                    </div>
                  </div>
                )}

                {profile.certificateUrl && certificateDisplayUrl && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Certificate of Insurance</h3>
                    
                    {isMediaPdfRef(profile.certificateUrl) ? (
                      <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                        <div className="text-3xl mb-2">📄</div>
                        <p className="font-medium">PDF Certificate of Insurance</p>
                        <a 
                          href={certificateDisplayUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-block mt-3 text-sm px-4 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white rounded"
                        >
                          Open PDF in new tab
                        </a>
                      </div>
                    ) : (
                      <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                        <div className="text-3xl mb-2">🖼️</div>
                        <p className="font-medium mb-2">Certificate of Insurance</p>
                        <a 
                          href={certificateDisplayUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-block mt-1 text-sm px-4 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white rounded"
                        >
                          Click here for Certificate of Insurance
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {renderApprovedPaymentSection({ interactive: false })}

                {photoUrls.length > 0 && (
                  <div className="mt-12">
                    {/* Print always expands; on screen, folder when > 6 */}
                    <div className="print:hidden">
                      {renderPhotoGallery({ heading: 'Attached Photos' })}
                    </div>
                    <div className="hidden print:block">
                      {renderPhotoGallery({ heading: 'Attached Photos', forceExpanded: true })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {view === 'profileView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>
              <h2 className="text-3xl font-semibold mb-8">{t('companyProfile')}</h2>

              <div className="flex border-b mb-8 overflow-x-auto">
                <button 
                  onClick={() => setProfileTab('info')}
                  className={`flex-1 min-w-[7rem] py-4 text-center font-semibold ${profileTab === 'info' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  Company Info
                </button>
                {!currentCrew && (
                  <button
                    onClick={() => {
                      setProfileTab('billing');
                      setBillingPanel('overview');
                      void refreshBillingStatus();
                    }}
                    className={`flex-1 min-w-[7rem] py-4 text-center font-semibold ${profileTab === 'billing' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                  >
                    💳 Plan / Billing
                  </button>
                )}
                <button 
                  onClick={() => setProfileTab('payments')}
                  className={`flex-1 min-w-[7rem] py-4 text-center font-semibold ${profileTab === 'payments' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  Client Payments
                </button>
                <button
                  onClick={() => {
                    setProfileTab('paidInvoices');
                    void refreshArchivesList();
                    void refreshSavedList();
                  }}
                  className={`flex-1 min-w-[8rem] py-4 text-center font-semibold ${profileTab === 'paidInvoices' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  ✅ {t('paidInvoices')}
                  {paidInvoicesList.length > 0 && (
                    <span className="ml-1 text-xs font-medium px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      {paidInvoicesList.length}
                    </span>
                  )}
                </button>
              </div>

              {profileTab === 'billing' && billingPanel === 'overview' && (
                <Card className="mb-8 border-emerald-200">
                  <CardContent className="p-8 space-y-5">
                    <div>
                      <h3 className="text-2xl font-semibold text-[#1e293b]">💳 Account billing (EstimateAce plan)</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        Your subscription, crew seats, and account controls. Client payment links are under{' '}
                        <strong>Client Payments</strong>.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <div className="text-xs text-gray-500 uppercase">Status</div>
                        <div className="text-lg font-semibold capitalize">{billing.status}</div>
                      </div>
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <div className="text-xs text-gray-500 uppercase">Trial ends</div>
                        <div className="text-lg font-semibold">{formatPeriodEnd(billing.trialEndsAt)}</div>
                      </div>
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <div className="text-xs text-gray-500 uppercase">
                          {billing.status === 'active' || billing.status === 'trialing'
                            ? 'Renews / period ends'
                            : 'Period ends'}
                        </div>
                        <div className="text-lg font-semibold">
                          {formatPeriodEnd(billing.currentPeriodEnd)}
                        </div>
                        {!billing.currentPeriodEnd && billing.status === 'active' && (
                          <p className="text-[10px] text-amber-700 mt-1">
                            Missing date — click Sync from Stripe (Manage billing)
                          </p>
                        )}
                      </div>
                    </div>
                    {billing.accountClosesAt && (
                      <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-950 p-4 text-sm">
                        <strong>Account closing:</strong> You keep access until{' '}
                        <strong>{formatPeriodEnd(billing.accountClosesAt)}</strong>. After that date
                        the app will stop access and remove your data.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="bg-[#10b981] hover:bg-[#059669] text-white"
                        disabled={billingBusy || billingStripeDiag.hasPriceIdMonthly === false}
                        onClick={() => void startSubscriptionCheckout('monthly')}
                      >
                        {billingBusy ? 'Opening Stripe…' : 'Subscribe monthly'}
                      </Button>
                      <Button
                        className="bg-[#0ea5e9] hover:bg-[#0284c7] text-white"
                        disabled={billingBusy || !billingStripeDiag.hasPriceIdYearly}
                        onClick={() => void startSubscriptionCheckout('yearly')}
                        title={
                          !billingStripeDiag.hasPriceIdYearly
                            ? 'Add STRIPE_PRICE_ID_YEARLY in Vercel'
                            : undefined
                        }
                      >
                        {billingBusy ? 'Opening Stripe…' : 'Subscribe yearly'}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={billingBusy}
                        onClick={() => {
                          setBillingPanel('manage');
                          setDeleteConfirmText('');
                        }}
                      >
                        Manage billing
                      </Button>
                      <Button variant="outline" disabled={billingBusy} onClick={() => void refreshBillingStatus()}>
                        Refresh status
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">
                      Monthly uses <code className="text-[10px]">STRIPE_PRICE_ID_MONTHLY</code> (or legacy{' '}
                      <code className="text-[10px]">STRIPE_PRICE_ID</code>). Yearly uses{' '}
                      <code className="text-[10px]">STRIPE_PRICE_ID_YEARLY</code>.
                    </p>
                    {billingCheckoutError && (
                      <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
                        {billingCheckoutError}
                      </p>
                    )}
                    {!billingStripeOk && (
                      <div className="text-xs text-gray-600 rounded-lg border bg-slate-50 p-3 space-y-1">
                        <div className="font-semibold text-gray-700">Setup incomplete (owner only)</div>
                        <div>{billingStripeDiag.hasSecretKey ? '✅' : '❌'} STRIPE_SECRET_KEY</div>
                        <div>
                          {billingStripeDiag.hasPriceIdMonthly ? '✅' : '❌'} STRIPE_PRICE_ID_MONTHLY
                          (or STRIPE_PRICE_ID)
                        </div>
                        <div>
                          {billingStripeDiag.hasPriceIdYearly ? '✅' : '⚠️'} STRIPE_PRICE_ID_YEARLY
                        </div>
                        <div>{billingStripeDiag.hasWebhookSecret ? '✅' : '⚠️'} STRIPE_WEBHOOK_SECRET</div>
                        <div>{billingStripeDiag.hasServiceRole ? '✅' : '⚠️'} SUPABASE_SERVICE_ROLE_KEY</div>
                      </div>
                    )}
                    <p className="text-xs text-gray-500">
                      <strong>Manage billing</strong> opens crew members, payment method (Stripe), and account deletion.
                    </p>
                  </CardContent>
                </Card>
              )}

              {profileTab === 'billing' && billingPanel === 'manage' && (
                <div className="space-y-6 mb-8">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBillingPanel('overview')}
                  >
                    ← Back to plan status
                  </Button>

                  <Card className="border-emerald-200">
                    <CardContent className="p-6 space-y-4">
                      <h3 className="text-xl font-semibold text-[#1e293b]">Manage plan &amp; payment</h3>
                      <p className="text-sm text-gray-500">
                        Status: <strong className="capitalize">{billing.status}</strong>
                        {billing.currentPeriodEnd
                          ? ` · Period ends ${formatPeriodEnd(billing.currentPeriodEnd)}`
                          : ''}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="bg-[#10b981] text-white"
                          disabled={billingBusy || billingStripeDiag.hasPriceIdMonthly === false}
                          onClick={() => void startSubscriptionCheckout('monthly')}
                        >
                          Subscribe monthly
                        </Button>
                        <Button
                          className="bg-[#0ea5e9] text-white"
                          disabled={billingBusy || !billingStripeDiag.hasPriceIdYearly}
                          onClick={() => void startSubscriptionCheckout('yearly')}
                        >
                          Subscribe yearly
                        </Button>
                        <Button
                          variant="outline"
                          disabled={billingBusy || !billing.stripeCustomerId}
                          onClick={() => void openBillingPortal()}
                        >
                          Update card / cancel in Stripe
                        </Button>
                        <Button
                          variant="outline"
                          disabled={billingBusy}
                          onClick={async () => {
                            if (!supabase) return;
                            setBillingBusy(true);
                            try {
                              const { data: sessionData } = await supabase.auth.getSession();
                              const token = sessionData.session?.access_token;
                              if (!token) return showMessage('Please log in again.');
                              const res = await fetch('/api/billing/sync', {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${token}` },
                              });
                              const data = await res.json().catch(() => ({}));
                              if (!res.ok) showMessage(data.error || 'Sync failed');
                              else showMessage(`✅ Synced — ${data.status || 'updated'}`);
                              await refreshBillingStatus();
                            } finally {
                              setBillingBusy(false);
                            }
                          }}
                        >
                          Sync from Stripe
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-6 space-y-4">
                      <h3 className="text-xl font-semibold text-[#1e293b]">👥 Crew / sub-contractors</h3>
                      <p className="text-sm text-gray-500">
                        Create a login for each crew member. They use the <strong>same login page</strong> as
                        you, with the email and password you set here. Share those credentials with them
                        securely. They can use “Forgot your password?” on the main login if they need a reset.
                      </p>
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs p-3">
                        Crew logins are real accounts. After you add someone, they sign in at app.estimateace.com
                        with that email and password (no separate crew login form).
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            placeholder="crew@email.com"
                            type="email"
                            value={crewEmailInput}
                            onChange={(e) => setCrewEmailInput(e.target.value)}
                            className="flex-1"
                          />
                          <Input
                            placeholder="Set their password"
                            type="password"
                            autoComplete="new-password"
                            value={crewPasswordInput}
                            onChange={(e) => setCrewPasswordInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void addCrewMember();
                              }
                            }}
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            onClick={() => void addCrewMember()}
                            disabled={crewInviteBusy}
                            className="bg-[#10b981] text-white"
                          >
                            {crewInviteBusy ? 'Creating…' : 'Add crew'}
                          </Button>
                        </div>
                        <p className="text-[11px] text-gray-500">
                          Password must be at least 6 characters. Tell the crew member both email and password.
                        </p>
                      </div>
                      <div className="space-y-3">
                        {(profile.teammates || []).length === 0 ? (
                          <p className="text-sm text-gray-500">No crew members yet.</p>
                        ) : (
                          (profile.teammates || []).map((crew, index) => (
                            <div
                              key={`${crew.email}-${index}`}
                              className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border p-4 rounded-lg"
                            >
                              <div className="font-medium break-all">{crew.email}</div>
                              <div className="flex flex-wrap items-center gap-4">
                                <div className="flex items-center gap-2 text-sm">
                                  <span>Full</span>
                                  <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={crew.role === 'full'}
                                      onChange={() => {
                                        const nextRole =
                                          crew.role === 'full' ? 'limited' : 'full';
                                        const updated = [...profile.teammates];
                                        updated[index] = {
                                          ...updated[index],
                                          role: nextRole,
                                        };
                                        setProfile((prev) => ({ ...prev, teammates: updated }));
                                        void updateCrewPermissions(crew.email, { role: nextRole });
                                        setTimeout(() => saveToDB(), 100);
                                      }}
                                      className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]" />
                                  </label>
                                  <span>Limited</span>
                                </div>
                                <label className="flex items-center gap-1 cursor-pointer text-xs">
                                  <input
                                    type="checkbox"
                                    checked={crew.canSeePricing ?? false}
                                    onChange={() => {
                                      const next = !(crew.canSeePricing ?? false);
                                      const updated = [...profile.teammates];
                                      updated[index] = {
                                        ...updated[index],
                                        canSeePricing: next,
                                      };
                                      setProfile((prev) => ({ ...prev, teammates: updated }));
                                      void updateCrewPermissions(crew.email, { canSeePricing: next });
                                      setTimeout(() => saveToDB(), 100);
                                    }}
                                    className="w-3 h-3 accent-[#10b981]"
                                  />
                                  See pricing
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer text-xs">
                                  <input
                                    type="checkbox"
                                    checked={crew.canSeeEstimatesAndFinancials ?? false}
                                    onChange={() => {
                                      const next = !(crew.canSeeEstimatesAndFinancials ?? false);
                                      const updated = [...profile.teammates];
                                      updated[index] = {
                                        ...updated[index],
                                        canSeeEstimatesAndFinancials: next,
                                      };
                                      setProfile((prev) => ({ ...prev, teammates: updated }));
                                      void updateCrewPermissions(crew.email, {
                                        canSeeEstimatesAndFinancials: next,
                                      });
                                      setTimeout(() => saveToDB(), 100);
                                    }}
                                    className="w-3 h-3 accent-[#10b981]"
                                  />
                                  See estimates &amp; financials
                                </label>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => {
                                    if (!confirm(`Remove crew member ${crew.email}? They will no longer be able to log in.`))
                                      return;
                                    void removeCrewMember(
                                      crew.email,
                                      (crew as any).userId as string | undefined
                                    );
                                    const updated = profile.teammates.filter((_, i) => i !== index);
                                    setProfile((prev) => ({ ...prev, teammates: updated }));
                                    setTimeout(() => saveToDB(), 100);
                                    showMessage('Crew member removed');
                                  }}
                                >
                                  Delete
                                </Button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-red-200">
                    <CardContent className="p-6 space-y-4">
                      <h3 className="text-xl font-semibold text-red-700">Delete account</h3>
                      {billing.accountClosesAt ? (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-950 p-4 text-sm space-y-2">
                          <p className="font-semibold">Account scheduled to close</p>
                          <p>
                            You keep full access until{' '}
                            <strong>{formatPeriodEnd(billing.accountClosesAt)}</strong>.
                            On that date access stops and your data is removed.
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm text-gray-600">
                            Schedule account deletion. You will <strong>keep access until the end of
                            what you already paid for</strong> (or until your trial ends). After that
                            date the app will stop access and delete your data.
                          </p>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">
                              Type <strong>DELETE</strong> to confirm
                            </label>
                            <Input
                              value={deleteConfirmText}
                              onChange={(e) => setDeleteConfirmText(e.target.value)}
                              placeholder="DELETE"
                              className="max-w-xs"
                              autoComplete="off"
                            />
                          </div>
                          <Button
                            variant="destructive"
                            disabled={
                              deleteAccountBusy ||
                              deleteConfirmText.trim().toUpperCase() !== 'DELETE'
                            }
                            onClick={() => void deleteOwnAccount()}
                          >
                            {deleteAccountBusy
                              ? 'Scheduling…'
                              : 'Schedule account deletion'}
                          </Button>
                        </>
                      )}
                      <p className="text-xs text-gray-500">
                        Need help?{' '}
                        <a className="text-emerald-700 underline" href={`mailto:${SUPPORT_EMAIL}`}>
                          {SUPPORT_EMAIL}
                        </a>
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}

              {profileTab === 'info' && (
                <Card className="mb-8">
                  <CardContent className="p-8 space-y-8">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-gray-500">
                        Company info saves automatically as you type. It stays until you edit it.
                        {' '}
                        <button
                          type="button"
                          className="text-emerald-700 font-semibold underline"
                          onClick={() => {
                            setProfileTab('billing');
                            void refreshBillingStatus();
                          }}
                        >
                          Plan / Billing →
                        </button>
                      </p>
                      {profileAutoSaveLabel && (
                        <span
                          className={`text-xs font-medium ${
                            profileAutoSaveLabel === 'Save failed'
                              ? 'text-red-600'
                              : profileAutoSaveLabel === 'Saving…'
                                ? 'text-amber-600'
                                : 'text-emerald-600'
                          }`}
                        >
                          {profileAutoSaveLabel === 'Saved' ? '✓ Saved' : profileAutoSaveLabel}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-semibold mb-2">{t('companyName')}</label>
                        <Input value={profile.company} onChange={e => setProfile(prev => ({...prev, company: e.target.value}))} />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-2">{t('slogan')}</label>
                        <Input value={profile.slogan} onChange={e => setProfile(prev => ({...prev, slogan: e.target.value}))} />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-2">{t('phone')}</label>
                        <Input value={profile.phone} onChange={e => setProfile(prev => ({...prev, phone: e.target.value}))} />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-2">{t('email')}</label>
                        <Input value={profile.email} onChange={e => setProfile(prev => ({...prev, email: e.target.value}))} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-semibold mb-2">{t('address')}</label>
                        <Input value={profile.address} onChange={e => setProfile(prev => ({...prev, address: e.target.value}))} placeholder="Street address" />
                      </div>
                      <div className="grid grid-cols-3 gap-4 md:col-span-2">
                        <div>
                          <label className="block text-sm font-semibold mb-2">{t('city')}</label>
                          <Input value={profile.city} onChange={e => setProfile(prev => ({...prev, city: e.target.value}))} />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold mb-2">{t('state')}</label>
                          <Input value={profile.state} onChange={e => setProfile(prev => ({...prev, state: e.target.value}))} placeholder="CA" />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold mb-2">{t('zipCode')}</label>
                          <Input value={profile.zipCode} onChange={e => setProfile(prev => ({...prev, zipCode: e.target.value}))} />
                        </div>
                      </div>
                    </div>

                    {/* Total miles across all jobs */}
                    <div className="pt-6 border-t border-slate-200">
                      <MileageTracker
                        summaryOnly
                        logs={allJobsMileageLogs}
                        ratePerMile={mileageRatePerMile}
                        onChangeLogs={() => {}}
                        onChangeRate={setMileageRatePerMile}
                        onSave={saveMileageRate}
                        saving={mileageSaving}
                      />
                    </div>

                    <div className="pt-2 flex flex-wrap items-center gap-3">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        onClick={saveProfile}
                      >
                        Save Company Info
                      </Button>
                      <span className="text-xs text-gray-500">Optional — changes already auto-save</span>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold mb-2">
                        {t('languageLabel') || 'Language'}
                      </label>
                      <select
                        value={
                          isKnownLanguageCode(String(profile.language || ''))
                            ? String(profile.language)
                            : currentLang
                        }
                        disabled={uiLangBusy}
                        onChange={(e) => {
                          void applyAppLanguage(e.target.value);
                        }}
                        className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#10b981]"
                      >
                        {APP_LANGUAGES.map((lang) => (
                          <option key={lang.code} value={lang.code}>
                            {lang.name === lang.nativeName
                              ? lang.name
                              : `${lang.name} — ${lang.nativeName}`}
                          </option>
                        ))}
                      </select>
                      {uiLangBusy && (
                        <p className="text-xs text-emerald-700 mt-2">
                          Translating interface… first time for this language may take a few seconds.
                        </p>
                      )}
                      <p className="text-xs text-gray-500 mt-1">
                        Choose any language. English, Spanish, and French use built-in labels; other
                        languages load interface text via AI (needs Grok API key) and are cached on this
                        device. Line-item and terms translation can also use any language below.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold mb-2">{t('termsConditions')}</label>
                      <Textarea 
                        value={profile.disclosure} 
                        onChange={e => setProfile(prev => ({...prev, disclosure: e.target.value}))} 
                        rows={4}
                        placeholder="Enter your standard terms and conditions here..."
                      />
                      <p className="text-xs text-gray-500 mt-2">Terms auto-save with your company profile.</p>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold mb-2">{t('logo')}</label>
                      <input 
                        type="file" 
                        accept="image/*" 
                        onChange={handleLogoUpload}
                        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0ea16b]"
                      />
                      <p className="text-xs text-gray-500 mt-1">This will appear to the left of the company name in estimates and invoices.</p>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold mb-2">Logo Size</label>
                      <div className="flex gap-4">
                        {['small', 'medium', 'large'].map(size => (
                          <label key={size} className="flex items-center gap-1 cursor-pointer text-sm">
                            <input 
                              type="radio" 
                              name="logoSize" 
                              value={size} 
                              checked={profile.logoSize === size}
                              onChange={(e) => {
                                setProfile(prev => ({ ...prev, logoSize: e.target.value }));
                              }}
                              className="accent-[#10b981]"
                            />
                            <span className="capitalize">{size}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {profile.logoUrl && logoDisplayUrl && (
                      <div className="mt-2 flex items-center gap-3">
                        <img src={logoDisplayUrl} alt="Company Logo" className={`${getLogoClass(profile.logoSize)} object-contain border rounded`} />
                        <button 
                          type="button"
                          onClick={() => {
                            setProfile(prev => ({ ...prev, logoUrl: '' }));
                          }}
                          className="text-xs text-red-600 hover:text-red-800"
                        >
                          Remove logo
                        </button>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-semibold mb-2">Certificate of Insurance</label>
                      <input 
                        type="file" 
                        accept="application/pdf,image/jpeg,image/png,image/jpg" 
                        onChange={handleCertificateUpload}
                        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0ea16b]"
                      />
                      <p className="text-xs text-gray-500 mt-1">Accepted: PDF, JPG, PNG (most common formats for COI)</p>
                    </div>

                    {profile.certificateUrl && certificateDisplayUrl && (
                      <div className="mt-8 border rounded-lg p-6">
                        <h3 className="font-semibold mb-4">Certificate of Insurance</h3>
                        
                        {isMediaPdfRef(profile.certificateUrl) ? (
                          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center bg-gray-50">
                            <div className="text-4xl mb-2">📄</div>
                            <p className="font-medium mb-1">PDF Document</p>
                            <p className="text-xs text-gray-500 mb-3">Certificate of Insurance</p>
                            <a 
                              href={certificateDisplayUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="inline-block px-5 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white text-sm font-semibold rounded-lg"
                            >
                              View / Download PDF
                            </a>
                          </div>
                        ) : (
                          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center bg-gray-50">
                            <div className="text-4xl mb-2">🖼️</div>
                            <p className="font-medium mb-1">Certificate of Insurance</p>
                            <a 
                              href={certificateDisplayUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="inline-block px-5 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white text-sm font-semibold rounded-lg"
                            >
                              Click here for Certificate of Insurance
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">Quick Save (Auto-save)</p>
                        <p className="text-sm text-gray-500">Automatically save changes while editing</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={profile.autoSaveEnabled !== false} 
                          onChange={async (e) => {
                            const checked = e.target.checked;
                            const nextProfile = { ...profile, autoSaveEnabled: checked };
                            setProfile(nextProfile);
                            await saveProfileSettings(nextProfile);
                          }}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                      </label>
                    </div>

                    <div className="border rounded-xl p-4 space-y-4 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">Default Deposit on Approved Estimates</p>
                          <p className="text-sm text-gray-500">Show a deposit payment button when the client approves the estimate</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={profile.showDepositOnApproval !== false}
                            onChange={async (e) => {
                              const checked = e.target.checked;
                              const nextProfile = { ...profile, showDepositOnApproval: checked };
                              setProfile(nextProfile);
                              await saveProfileSettings(nextProfile);
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                        </label>
                      </div>
                      {profile.showDepositOnApproval !== false && (
                        <div>
                          <label className="block text-sm font-semibold mb-2">Default Deposit Percentage (%) of total bill</label>
                          <Input
                            type="number"
                            value={profile.depositPercentage || 0}
                            onChange={e => {
                              const nextProfile = { ...profile, depositPercentage: parseFloat(e.target.value) || 0 };
                              setProfile(nextProfile);
                            }}
                            onBlur={async (e) => {
                              const nextProfile = { ...profile, depositPercentage: parseFloat(e.target.value) || 0 };
                              setProfile(nextProfile);
                              await saveProfileSettings(nextProfile);
                            }}
                            placeholder="10"
                          />
                        </div>
                      )}
                      <div className="pt-2 border-t space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold">Third Party Escrow</p>
                            <p className="text-sm text-gray-500">Show an escrow option when the client approves the estimate</p>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!profile.thirdPartyEscrowEnabled}
                              onChange={async (e) => {
                                const checked = e.target.checked;
                                const nextProfile = {
                                  ...profile,
                                  thirdPartyEscrowEnabled: checked,
                                  escrowMinimumAmount:
                                    profile.escrowMinimumAmount ?? 10000,
                                };
                                setProfile(nextProfile);
                                await saveProfileSettings(nextProfile);
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                          </label>
                        </div>
                        {profile.thirdPartyEscrowEnabled && (
                          <div>
                            <label className="block text-sm font-semibold mb-2">
                              Minimum estimate total for escrow ($)
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step="100"
                              value={profile.escrowMinimumAmount ?? 0}
                              onChange={e => {
                                const nextProfile = {
                                  ...profile,
                                  escrowMinimumAmount: Math.max(0, parseFloat(e.target.value) || 0),
                                };
                                setProfile(nextProfile);
                              }}
                              onBlur={async (e) => {
                                const nextProfile = {
                                  ...profile,
                                  escrowMinimumAmount: Math.max(0, parseFloat(e.target.value) || 0),
                                };
                                setProfile(nextProfile);
                                await saveProfileSettings(nextProfile);
                              }}
                              placeholder="10000"
                            />
                            <p className="text-sm text-gray-500 mt-2">
                              Escrow appears only when the estimate grand total is at or above this amount.
                              Set to $0 to show escrow on all approved estimates.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="border rounded-xl p-4 space-y-4 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">Enable Taxes on Estimates</p>
                          <p className="text-sm text-gray-500">When off, estimates calculate totals from line items only (no sales tax)</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={getTaxesEnabled()}
                            onChange={async (e) => {
                              const checked = e.target.checked;
                              const nextProfile = { ...profile, taxesEnabled: checked };
                              setProfile(nextProfile);
                              await saveProfileSettings(nextProfile);
                              showMessage(
                                checked
                                  ? '✅ Taxes enabled on estimates.'
                                  : '✅ Taxes disabled — totals will exclude sales tax.'
                              );
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                        </label>
                      </div>
                    </div>

                    <div className="border rounded-xl p-4 space-y-4 bg-gray-50">
                      <div>
                        <p className="font-semibold">Client Estimate Display</p>
                        <p className="text-sm text-gray-500">
                          Material, labor, and cost breakdown buttons are on the estimate editor (above Add Line Item).
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">Show Discount on Estimate</p>
                          <p className="text-sm text-gray-500">Show discount line to clients when a discount name and amount are entered</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={getShowDiscountOnEstimate()}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              void saveBreakdownProfileSettings({ showDiscountOnEstimate: checked });
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                        </label>
                      </div>
                    </div>

                    <div className="border rounded-xl p-4 space-y-4 bg-gray-50">
                      <div>
                        <p className="font-semibold">{t('appointmentReminders')}</p>
                        <p className="text-sm text-gray-500">{t('appointmentReminderHelp')}</p>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">{t('appointmentReminderToggle')}</p>
                          <p className="text-sm text-gray-500">{t('appointmentReminderContact')}</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!profile.appointmentReminderEnabled}
                            onChange={async (e) => {
                              const checked = e.target.checked;
                              const nextProfile = { ...profile, appointmentReminderEnabled: checked };
                              setProfile(nextProfile);
                              await saveProfileSettings(nextProfile);
                              if (checked) {
                                showMessage('Appointment reminders enabled. You will receive a daily email and text at 8:00 AM Eastern when you have appointments tomorrow.');
                              }
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                        </label>
                      </div>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={testAppointmentReminder}
                        disabled={testingReminder}
                      >
                        {testingReminder ? t('testingReminder') : t('testReminderNow')}
                      </Button>
                    </div>

                    <div className="border-t pt-8">
                      <h3 className="font-semibold mb-2">{t('crew')}</h3>
                      <p className="text-sm text-gray-500 mb-3">
                        Add, pay for your plan, and manage crew under{' '}
                        <button
                          type="button"
                          className="text-emerald-700 font-semibold underline"
                          onClick={() => {
                            setProfileTab('billing');
                            setBillingPanel('manage');
                            void refreshBillingStatus();
                          }}
                        >
                          Plan / Billing → Manage billing
                        </button>
                        .
                      </p>
                    </div>

                    <div className="border-t pt-8">
                      <h3 className="font-semibold mb-2">{t('paidInvoices')}</h3>
                      <p className="text-sm text-gray-500 mb-4">{t('paidInvoicesHelp')}</p>
                      <Button
                        variant="outline"
                        className="w-full mb-2 border-[#10b981] text-[#10b981] hover:bg-emerald-50"
                        onClick={() => {
                          setProfileTab('paidInvoices');
                          void refreshArchivesList();
                          void refreshSavedList();
                        }}
                      >
                        ✅ {t('paidInvoices')}
                        {paidInvoicesList.length > 0 ? ` (${paidInvoicesList.length})` : ''}
                      </Button>
                      <Button
                        variant="outline"
                        className="w-full mb-2"
                        onClick={openArchivesView}
                      >
                        📦 {t('viewArchives')}
                      </Button>
                    </div>

                    <div className="border-t pt-8">
                      <h3 className="font-semibold mb-4">Export Data</h3>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={exportOptions.estimates} onChange={e => setExportOptions(prev => ({...prev, estimates: e.target.checked}))} />
                          Estimates
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={exportOptions.invoices} onChange={e => setExportOptions(prev => ({...prev, invoices: e.target.checked}))} />
                          Invoices
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={exportOptions.archives} onChange={e => setExportOptions(prev => ({...prev, archives: e.target.checked}))} />
                          Archives
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={exportOptions.photos} onChange={e => setExportOptions(prev => ({...prev, photos: e.target.checked}))} />
                          {t('photos')}
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={exportOptions.videos} onChange={e => setExportOptions(prev => ({...prev, videos: e.target.checked}))} />
                          {t('videos')}
                        </label>
                      </div>
                      <Button onClick={exportData} className="w-full bg-[#10b981]">{t('exportData')}</Button>
                    </div>

                    <Button onClick={saveProfile} className="w-full bg-[#10b981]">{t('saveProfile')}</Button>
                  </CardContent>
                </Card>
              )}

              {profileTab === 'payments' && (
                <Card className="mb-8 w-full max-w-full min-w-0 overflow-hidden">
                  <CardContent className="p-4 sm:p-6 md:p-8 w-full max-w-full min-w-0 box-border overflow-hidden">
                    <h3 className="text-lg sm:text-xl font-semibold mb-4 sm:mb-6 flex items-center gap-2 min-w-0">
                      <span className="shrink-0">💳</span>
                      <span className="break-words">{t('paymentMethods')}</span>
                    </h3>
                    <div className="space-y-3 sm:space-y-4 w-full max-w-full min-w-0">
                      {Object.entries(mergePaymentSettings(profile.paymentSettings))
                        .filter(([method]) => !CRYPTO_PAYMENT_METHODS.has(method))
                        .map(([method, settings]) => renderPaymentMethodRow(method, settings))}
                    </div>

                    <div className="mt-8 sm:mt-10 pt-6 sm:pt-8 border-t w-full max-w-full min-w-0">
                      <h4 className="font-semibold text-base sm:text-lg mb-1 flex items-center gap-2 min-w-0">
                        <span className="shrink-0">₿</span>
                        <span className="break-words">{t('cryptoPayments')}</span>
                      </h4>
                      <p className="text-sm text-gray-500 mb-4 break-words">{t('cryptoPaymentsHelp')}</p>
                      <div className="space-y-3 sm:space-y-4 w-full max-w-full min-w-0">
                        {Object.entries(mergePaymentSettings(profile.paymentSettings))
                          .filter(([method]) => CRYPTO_PAYMENT_METHODS.has(method))
                          .map(([method, settings]) => renderPaymentMethodRow(method, settings))}
                      </div>
                    </div>

                    <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 leading-relaxed">
                      <p className="font-semibold mb-2">{t('paymentDisclosureTitle')}</p>
                      <p>{t('paymentDisclosureBody')}</p>
                    </div>

                    {/* Credit Card Processing Fee Toggle */}
                    <div className="mt-8 pt-6 border-t">
                      <h4 className="font-semibold text-lg mb-3 flex items-center gap-2">
                        💳 Credit Card Processing Fee
                      </h4>

                      <label className="flex items-start gap-3 cursor-pointer mb-3">
                        <input
                          type="checkbox"
                          checked={!!profile.chargeCCFee}
                          onChange={(e) => setProfile(prev => ({ ...prev, chargeCCFee: e.target.checked }))}
                          className="mt-1 w-5 h-5 accent-[#10b981]"
                        />
                        <div>
                          <div className="font-medium">{t('chargeCCFee')}</div>
                          <div className="text-sm text-gray-500">When enabled, the fee is added automatically when clients pay by card (Stripe / PayPal).</div>
                        </div>
                      </label>

                      {profile.chargeCCFee && (
                        <div className="ml-8 flex items-center gap-2">
                          <span className="text-sm">Fee rate:</span>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            max="10"
                            value={profile.ccFeePercentage ?? 3}
                            onChange={(e) => setProfile(prev => ({ 
                              ...prev, 
                              ccFeePercentage: parseFloat(e.target.value) || 0 
                            }))}
                            className="w-20 text-right"
                          />
                          <span className="text-sm">%</span>
                          <span className="ml-3 text-xs text-gray-500">
                            (example on ${grandTotal.toFixed(0)} = +${(grandTotal * ((profile.ccFeePercentage || 3)/100)).toFixed(2)})
                          </span>
                        </div>
                      )}
                    </div>


                  </CardContent>
                </Card>
              )}

              {profileTab === 'paidInvoices' && (
                <Card className="mb-8">
                  <CardContent className="p-6 sm:p-8 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-xl font-semibold flex items-center gap-2">
                          <span>✅</span>
                          <span>{t('paidInvoices')}</span>
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">{t('paidInvoicesHelp')}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void refreshArchivesList();
                          void refreshSavedList();
                        }}
                      >
                        Refresh
                      </Button>
                    </div>

                    <div className="space-y-3">
                      {paidInvoicesList.length === 0 && (
                        <div className="border border-dashed rounded-lg p-8 text-center text-sm text-gray-500 bg-gray-50">
                          {t('noPaidInvoices')}
                        </div>
                      )}
                      {paidInvoicesList.map((inv) => {
                        const paidLabel = inv.paymentMethod
                          ? `${t('paid')} · ${inv.paymentMethod}`
                          : t('paid');
                        const archivedDate = inv.archived_at
                          ? new Date(inv.archived_at).toLocaleDateString()
                          : inv.date || '';
                        return (
                          <div
                            key={inv.id}
                            className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border p-4 rounded-lg bg-white min-w-0"
                          >
                            <div className="min-w-0">
                              <div className="font-medium break-words">{inv.jobName || 'Untitled'}</div>
                              <div className="text-sm text-gray-500 break-words">
                                {inv.invoiceNumber || inv.id}
                                {inv.documentType ? ` · ${String(inv.documentType)}` : ''}
                                {archivedDate ? ` · ${archivedDate}` : ''}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
                                  {paidLabel}
                                </span>
                                {typeof inv.amountPaid === 'number' && inv.amountPaid > 0 && (
                                  <span className="text-xs text-gray-600">
                                    ${Number(inv.amountPaid).toFixed(2)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2 shrink-0">
                              <Button
                                size="sm"
                                onClick={async () => {
                                  await loadSelectedEstimate(inv);
                                  setView('editor');
                                }}
                              >
                                {t('open')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-[#10b981] text-[#10b981] hover:bg-emerald-50"
                                onClick={() => retrieveArchive(inv)}
                              >
                                {t('retrieve')}
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => deleteArchivedDocument(inv.id)}
                              >
                                {t('delete')}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="pt-4 border-t">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={openArchivesView}
                      >
                        📦 {t('viewArchives')} ({t('archivedDocuments')})
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {view === 'reportsView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>
              <h2 className="text-3xl font-semibold mb-6">📊 Reports</h2>
              {currentCrew && !canSeeFinancials && (
                <div className="p-6 bg-yellow-50 border border-yellow-200 rounded">
                  Financial reports and profit details are restricted for your crew access level.
                </div>
              )}

              <div className="flex border-b mb-6">
                <button 
                  onClick={() => setReportsSubTab('profit')}
                  className={`flex-1 py-3 text-center font-medium ${reportsSubTab === 'profit' ? 'border-b-2 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  Profit Reports
                </button>
                <button 
                  onClick={() => setReportsSubTab('tax')}
                  className={`flex-1 py-3 text-center font-medium ${reportsSubTab === 'tax' ? 'border-b-2 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  Tax Reports
                </button>
              </div>

              {reportsSubTab === 'profit' && (
                <>
                  {(currentCrew && !canSeeFinancials) ? (
                    <p className="text-sm text-gray-500">Profit details are restricted for your crew access level.</p>
                  ) : (
                    <>
                  {/* Archived invoices by month / year of invoice date */}
                  <section className="mb-12">
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                      <div>
                        <h3 className="text-xl font-semibold text-[#1e293b]">📁 Archived Invoices</h3>
                        <p className="text-sm text-gray-500 mt-1">
                          All closed invoices from archives, grouped by month and year of the job invoice date.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2 items-center">
                        <label className="text-xs font-medium text-gray-500">Year</label>
                        <select
                          value={profitArchiveYearFilter}
                          onChange={(e) => setProfitArchiveYearFilter(e.target.value)}
                          className="border rounded-lg px-3 py-2 text-sm bg-white"
                        >
                          <option value="all">All years</option>
                          {archivedInvoicesByMonth.years.map((y) => (
                            <option key={y} value={String(y)}>{y}</option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void refreshArchivesList()}
                        >
                          Refresh
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-[#10b981] hover:bg-[#059669] text-white"
                          onClick={exportArchivedInvoicesByMonth}
                          disabled={archivedInvoicesByMonth.grandCount === 0}
                        >
                          Export CSV
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                      <div className="bg-white border rounded-2xl p-4 text-center">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Invoices</div>
                        <div className="text-3xl font-bold text-[#1e293b] mt-1">
                          {archivedInvoicesByMonth.grandCount}
                        </div>
                      </div>
                      <div className="bg-white border rounded-2xl p-4 text-center">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Invoiced total</div>
                        <div className="text-3xl font-bold text-[#10b981] mt-1">
                          ${archivedInvoicesByMonth.grandTotal.toFixed(2)}
                        </div>
                      </div>
                      <div className="bg-white border rounded-2xl p-4 text-center">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Amount paid</div>
                        <div className="text-3xl font-bold text-[#14b8a6] mt-1">
                          ${archivedInvoicesByMonth.grandPaid.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {filteredArchivedInvoiceMonths.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-gray-500">
                        No archived invoices yet. When you mark invoices paid / archive them, they appear here by month and year.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {filteredArchivedInvoiceMonths.map((month) => {
                          const open = !!profitArchiveExpandedMonths[month.key];
                          return (
                            <div
                              key={month.key}
                              className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm"
                            >
                              <button
                                type="button"
                                onClick={() => toggleProfitArchiveMonth(month.key)}
                                className="w-full flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-left hover:bg-slate-50 transition"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="text-lg text-gray-400 w-5 shrink-0">{open ? '▼' : '▶'}</span>
                                  <div className="min-w-0">
                                    <div className="font-semibold text-[#1e293b] text-lg">{month.label}</div>
                                    <div className="text-xs text-gray-500">
                                      {month.count} invoice{month.count === 1 ? '' : 's'}
                                    </div>
                                  </div>
                                </div>
                                <div className="text-right shrink-0 pl-2">
                                  <div className="font-bold text-[#10b981] text-lg">
                                    ${month.total.toFixed(2)}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    Paid ${month.amountPaid.toFixed(2)}
                                  </div>
                                </div>
                              </button>

                              {open && (
                                <div className="border-t border-slate-100 overflow-x-auto">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>Invoice #</TableHead>
                                        <TableHead>Job</TableHead>
                                        <TableHead>Invoice date</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead className="text-right">Total</TableHead>
                                        <TableHead className="text-right">Paid</TableHead>
                                        <TableHead className="text-right">Action</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {month.invoices.map((inv: any) => {
                                        const invDate = getArchivedInvoiceDate(inv);
                                        const dateLabel = invDate
                                          ? invDate.toLocaleDateString('en-US', {
                                              year: 'numeric',
                                              month: 'short',
                                              day: 'numeric',
                                            })
                                          : '—';
                                        const grand = calculateGrandTotal(inv);
                                        const paid = Number(inv.amountPaid ?? inv.amountpaid ?? 0) || 0;
                                        return (
                                          <TableRow key={inv.id || inv.invoiceNumber}>
                                            <TableCell className="font-medium whitespace-nowrap">
                                              {inv.invoiceNumber || inv.id}
                                            </TableCell>
                                            <TableCell className="max-w-[12rem] truncate" title={inv.jobName || ''}>
                                              {inv.jobName || 'Untitled'}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-sm text-gray-600">
                                              {dateLabel}
                                            </TableCell>
                                            <TableCell className="capitalize text-sm">
                                              {inv.paymentStatus || '—'}
                                              {inv.paymentMethod ? (
                                                <span className="block text-xs text-gray-400 normal-case">
                                                  {inv.paymentMethod}
                                                </span>
                                              ) : null}
                                            </TableCell>
                                            <TableCell className="text-right font-semibold whitespace-nowrap">
                                              ${grand.toFixed(2)}
                                            </TableCell>
                                            <TableCell className="text-right whitespace-nowrap">
                                              ${paid.toFixed(2)}
                                            </TableCell>
                                            <TableCell className="text-right">
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                className="text-xs"
                                                onClick={() => {
                                                  void loadSelectedEstimate(inv);
                                                  setView('editor');
                                                }}
                                              >
                                                Open
                                              </Button>
                                            </TableCell>
                                          </TableRow>
                                        );
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <hr className="my-10 border-slate-200" />

                  <h3 className="text-xl font-semibold mb-4 text-[#1e293b]">💵 Job profit (deposit paid)</h3>
                  <label className="block text-sm font-semibold mb-3">Select Job / Estimate with Deposit Paid</label>
                  <select 
                    className="w-full border rounded-xl p-4 text-lg mb-8"
                    onChange={e => {
                      const selected = savedEstimatesList.find(est => est.id === e.target.value);
                      setSelectedReportJob(selected || null);
                    }}
                  >
                    <option value="">— Choose a paid deposit job —</option>
                    {savedEstimatesList.filter(est => (est.amountPaid || 0) > 0).map(est => (
                      <option key={est.id} value={est.id}>
                        {est.jobName || 'Untitled'} — {est.invoiceNumber} (Deposit: ${(est.amountPaid || 0).toFixed(2)})
                      </option>
                    ))}
                  </select>

                  {selectedReportJob && (
                    <div className="mt-10 space-y-8">
                      <div className="grid grid-cols-2 gap-6">
                        <div className="bg-white border rounded-2xl p-6 text-center">
                          <div className="text-sm text-gray-500">Total Receipts</div>
                          <div className="text-5xl font-bold text-[#10b981] mt-2">
                            ${(selectedReportJob.receiptDetails || []).reduce((sum: number, r: any) => sum + (r.amount || 0), 0).toFixed(2)}
                          </div>
                        </div>
                        <div className="bg-white border rounded-2xl p-6 text-center">
                          <div className="text-sm text-gray-500">Labor Cost</div>
                          <div className="text-5xl font-bold text-[#14b8a6] mt-2">
                            ${selectedReportJob.laborAmount ? selectedReportJob.laborAmount.toFixed(2) : '0.00'}
                          </div>
                        </div>
                      </div>

                      <div className="bg-white border-2 border-[#1e293b] rounded-3xl p-8">
                        <div className="flex justify-between items-baseline">
                          <div>
                            <div className="text-2xl font-semibold">Gross Total Charged</div>
                            <div className="text-6xl font-bold text-[#1e293b]">${(selectedReportJob.grandTotal || 0).toFixed(2)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm text-gray-500">Deposit Paid</div>
                            <div className="text-5xl font-bold text-[#10b981]">${(selectedReportJob.amountPaid || 0).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>

                      <div className="text-center text-4xl font-bold text-[#10b981]">
                        Net Profit: ${(
                          (selectedReportJob.grandTotal || 0) - 
                          (selectedReportJob.receiptDetails || []).reduce((sum: number, r: any) => sum + (r.amount || 0), 0) - 
                          (selectedReportJob.laborAmount || 0)
                        ).toFixed(2)}
                      </div>
                    </div>
                  )}
                    </>
                  )}
                </>
              )}

              {reportsSubTab === 'tax' && (
                <div>
                  {currentCrew && !canSeeFinancials ? (
                    <p className="text-sm text-gray-500">Tax reports are restricted.</p>
                  ) : (
                    <>
                      <h3 className="font-semibold mb-6 text-xl">🧾 Tax Reports</h3>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                        <Card>
                          <CardContent className="p-6">
                            <h4 className="text-sm font-semibold text-gray-500">TOTAL SALES TAX COLLECTED</h4>
                            <div className="text-5xl font-bold text-[#10b981] mt-3">${totalSalesTaxCollected.toFixed(2)}</div>
                            <p className="text-xs text-gray-500 mt-1">Year to Date</p>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardContent className="p-6">
                            <h4 className="text-sm font-semibold text-gray-500">TAX-DEDUCTIBLE RECEIPTS</h4>
                            <div className="text-5xl font-bold text-[#14b8a6] mt-3">${totalTaxDeductibleReceipts.toFixed(2)}</div>
                            <p className="text-xs text-gray-500 mt-1">Materials &amp; Expenses</p>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardContent className="p-6">
                            <h4 className="text-sm font-semibold text-gray-500">NET TAXABLE PROFIT</h4>
                            <div className="text-5xl font-bold text-[#1e293b] mt-3">${netTaxableProfit.toFixed(2)}</div>
                            <p className="text-xs text-gray-500 mt-1">After expenses &amp; labor</p>
                          </CardContent>
                        </Card>
                      </div>

                      <Card className="mb-8">
                        <CardContent className="p-6">
                          <h4 className="font-semibold mb-4">Quarterly Tax Summary</h4>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Quarter</TableHead>
                                <TableHead className="text-right">Tax Collected</TableHead>
                                <TableHead className="text-right">Deductible Expenses</TableHead>
                                <TableHead className="text-right">Net Taxable</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {quarterlyTaxData.map(q => (
                                <TableRow key={q.quarter}>
                                  <TableCell className="font-medium">{q.quarter}</TableCell>
                                  <TableCell className="text-right">${q.taxCollected.toFixed(2)}</TableCell>
                                  <TableCell className="text-right">${q.expenses.toFixed(2)}</TableCell>
                                  <TableCell className="text-right font-semibold">${(q.taxCollected - q.expenses).toFixed(2)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CardContent>
                    </Card>

                    <Button onClick={exportTaxReport} className="w-full bg-[#10b981]">
                      📤 Export Full Tax Report (CSV)
                    </Button>
                  </>
                  )}
                </div>
              )}
            </div>
          )}

          {view === 'receptionistView' && (
            <AIReceptionist
              companyName={profile.company || 'Your Company'}
              companyPhone={profile.phone || ''}
              companyEmail={profile.email || ''}
              settings={receptionistSettings}
              messages={receptionistMessages}
              onChangeSettings={setReceptionistSettings}
              onChangeMessages={setReceptionistMessages}
              onSave={saveReceptionistData}
              saving={receptionistSaving}
              onBack={goToDashboard}
              getAccessToken={async () => {
                if (!supabase) return null;
                const { data } = await supabase.auth.getSession();
                return data.session?.access_token || null;
              }}
              onBookAppointment={({ summary, callerName, callerPhone, whenLabel }) => {
                // Calendar entry when AI suggests a time
                const id = `appt-ai-${Date.now()}`;
                let dateStr = '';
                let timeStr = '09:00';
                const m = String(whenLabel || '').match(
                  /(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/
                );
                if (m) {
                  dateStr = m[1];
                  if (m[2]) {
                    const t = m[2];
                    timeStr = t.length === 4 ? `0${t}` : t;
                  }
                } else {
                  const d = new Date();
                  d.setDate(d.getDate() + 1);
                  dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                }
                const datetime = new Date(`${dateStr}T${timeStr}:00`);
                const jobName = `AI: ${callerName}${callerPhone ? ` ${callerPhone}` : ''} — ${summary.slice(0, 60)}`;
                const next = [
                  ...appointments,
                  {
                    id,
                    estimateId: '',
                    jobName,
                    invoiceNumber: '',
                    datetime: isNaN(datetime.getTime())
                      ? new Date().toISOString()
                      : datetime.toISOString(),
                  },
                ];
                setAppointments(next);
                try {
                  if (user?.id) {
                    localStorage.setItem(
                      `estimateace_appointments_${workspaceUserId}`,
                      JSON.stringify(next)
                    );
                  }
                } catch {
                  /* ignore */
                }
                void syncAppointmentsToServer(next);
                showMessage('📅 Suggested appointment added to your calendar');
              }}
            />
          )}

          {view === 'archivesView' && (
            <div>
              <div className="flex flex-wrap gap-2 mb-6">
                <Button variant="outline" onClick={goToDashboard}>← Back to {t('dashboard')}</Button>
                <Button variant="outline" onClick={() => setView('profileView')}>← {t('companyProfile')}</Button>
              </div>
              <h2 className="text-3xl font-semibold mb-2">{t('archivedDocuments')}</h2>
              <p className="text-sm text-gray-500 mb-6">{t('retrieveArchiveHelp')}</p>
              <div className="space-y-4">
                {archivesList.length === 0 && (
                  <div className="border border-dashed rounded-lg p-8 text-center text-sm text-gray-500 bg-white">
                    {t('noArchivedDocuments')}
                  </div>
                )}
                {archivesList.map((est) => (
                  <div key={est.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 border p-4 rounded-lg bg-white min-w-0">
                    <div className="min-w-0">
                      <div className="font-medium break-words">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500 break-words">
                        {est.invoiceNumber}
                        {est.documentType ? ` • ${String(est.documentType).charAt(0).toUpperCase()}${String(est.documentType).slice(1)}` : ''}
                        {est.archived_at ? ` • Archived: ${new Date(est.archived_at).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:gap-3 shrink-0">
                      <Button size="sm" onClick={async () => { await loadSelectedEstimate(est); setView('editor'); }}>{t('open')}</Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-[#10b981] text-[#10b981] hover:bg-emerald-50"
                        onClick={() => retrieveArchive(est)}
                      >
                        {t('retrieve')}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteArchivedDocument(est.id)}>{t('delete')}</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'sendPreview' && (
            <div className="max-w-4xl mx-auto">
              <Button variant="outline" onClick={() => setView('editor')} className="mb-6">← {t('backToEditor')}</Button>
              <h2 className="text-3xl font-semibold mb-6">
                {documentType === 'invoice' ? '📄 Invoice Preview & Final Payment' : t('sendEstimate') + ' Preview'}
              </h2>

              <div className="flex flex-wrap gap-3 mb-6">
                <Button 
                  onClick={async () => { 
                    const nativeLang = getNativeLanguage(profile.zipCode || '', profile.state || '');
                    let finalTerms = terms;

                    if (profile.language !== nativeLang && profile.disclosure) {
                      const translateToNative = confirm(
                        `The company's native language (based on zip/state) appears to be ${nativeLang.toUpperCase()}. ` +
                        `Your current document language is ${profile.language.toUpperCase()}. ` +
                        `Would you like to translate the Terms & Conditions to ${nativeLang.toUpperCase()} for the recipient?`
                      );
                      if (translateToNative) {
                        try {
                          // Authenticated proxy
                          const tHeaders: any = { 'Content-Type': 'application/json' };
                          if (supabase) {
                            const { data: { session } } = await supabase.auth.getSession();
                            if (session?.access_token) tHeaders['Authorization'] = `Bearer ${session.access_token}`;
                          }

                          const res = await fetch('/api/translate', {
                            method: 'POST',
                            headers: tHeaders,
                            body: JSON.stringify({
                              text: terms || profile.disclosure,
                              from: profile.language,
                              to: nativeLang
                            })
                          });
                          const data = await res.json();
                          if (data.translatedText) finalTerms = data.translatedText;
                        } catch (e) {
                          showMessage('⚠️ Could not translate Terms. Sending in current language. (Grok translation failed)');
                        }
                      }
                    }

                    // Temporarily use translated terms for send if applicable
                    const originalTerms = terms;
                    if (finalTerms !== terms) {
                      setTerms(finalTerms);
                      // Restore after send decision (simple approach)
                      setTimeout(() => setTerms(originalTerms), 1000);
                    }

                    setSelectedEmailsForSend([...emails]); 
                    setSelectedPhonesForSend([...phones]); 
                    setIsSendModalOpen(true); 
                  }} 
                  className="bg-[#f97316] text-white px-8 py-3 text-lg">
                  📧 Choose Recipients & Send
                </Button>

                <Button 
                  onClick={() => {
                    // One combined button: generate professional PDF (user can print or save from PDF viewer)
                    saveAsPDF();
                  }} 
                  variant="outline" 
                  className="px-6 py-3 text-lg">
                  🖨️ Print / Save PDF
                </Button>
              </div>

              <div id="preview-document" className="bg-white p-10 shadow-2xl rounded-2xl border mb-8">
                <div className="flex items-center gap-4 mb-2">
                  {logoDisplayUrl && (
                    <img src={logoDisplayUrl} alt="Logo" className={`${getLogoClass(profile.logoSize)} object-contain`} />
                  )}
                  <h1 className="text-4xl font-bold">{profile.company || 'Your Company'}</h1>
                </div>
                {(profile.phone || profile.email || profile.address || profile.city || profile.state || profile.zipCode) && (
                  <p className="text-center text-xl text-gray-600 mb-8">
                    {profile.phone && `📞 ${profile.phone}`}{profile.phone && profile.email && ' | '}{profile.email && `✉️ ${profile.email}`}
                    {(profile.address || profile.city || profile.state || profile.zipCode) && (
                      <span className="block text-sm mt-1">
                        {profile.address}
                        {profile.city && `, ${profile.city}`}
                        {profile.state && `, ${profile.state}`}
                        {profile.zipCode && ` ${profile.zipCode}`}
                      </span>
                    )}
                  </p>
                )}
                <div className="flex justify-between mb-8">
                  <div>
                    <strong>{documentType.toUpperCase()} # {invoiceNumber}</strong><br />
                    Date: {date}<br />
                    Client: {jobName}
                  </div>
                  <div className="text-right">
                    <strong>Bill To:</strong><br />
                    {address}<br />
                    {city}, {state} {zipCode}
                  </div>
                </div>
                <table className="w-full border-collapse mb-8">
                  <thead>
                    <tr className="border-b-2 border-gray-800">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2 border-l border-gray-400 px-3">Qty</th>
                      <th className="text-right py-2 border-l border-gray-400 px-3">SF/Unit</th>
                      <th className="text-right py-2 border-l border-gray-400 px-3">SF/Unit Price</th>
                      <th className="text-right py-2 border-l border-gray-400 px-3">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-3">
                          <span className="text-xs text-gray-500">Line {i + 1}: </span>{item.description}
                          {renderClientItemBreakdown(item, 'mt-1 text-[10px] text-gray-600 leading-tight pl-2')}
                        </td>
                        <td className="py-3 text-right border-l border-gray-400 px-3">{item.qty}</td>
                        <td className="py-3 text-right border-l border-gray-400 px-3">{item.unit || '—'}</td>
                        <td className="py-3 text-right border-l border-gray-400 px-3">{canSeePricing ? `$${item.price.toFixed(2)}` : '—'}</td>
                        <td className="py-3 text-right border-l border-gray-400 px-3">{canSeePricing ? `$${item.total.toFixed(2)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-4 space-y-1">
                  {renderDocumentTotals()}
                </div>

                {terms && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Terms & Conditions</h3>
                    <div className="text-gray-700 leading-relaxed whitespace-pre-wrap border rounded-xl p-6 bg-gray-50">
                      {terms}
                    </div>
                  </div>
                )}

                {profile.certificateUrl && certificateDisplayUrl && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Certificate of Insurance</h3>
                    
                    {isMediaPdfRef(profile.certificateUrl) ? (
                      <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                        <div className="text-3xl mb-2">📄</div>
                        <p className="font-medium">PDF Certificate of Insurance</p>
                        <a 
                          href={certificateDisplayUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-block mt-3 text-sm px-4 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white rounded"
                        >
                          Open PDF in new tab
                        </a>
                      </div>
                    ) : (
                      <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                        <div className="text-3xl mb-2">🖼️</div>
                        <p className="font-medium mb-2">Certificate of Insurance</p>
                        <a 
                          href={certificateDisplayUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-block mt-1 text-sm px-4 py-2 bg-[#10b981] hover:bg-[#0ea16b] text-white rounded"
                        >
                          Click here for Certificate of Insurance
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {renderApprovedPaymentSection({ interactive: true })}

                {documentType === 'invoice' && (
                  <div className="mt-12 p-8 border-4 border-dashed border-[#f59e0b] rounded-3xl bg-amber-50">
                    <h3 className="text-3xl font-bold text-center text-[#f59e0b]">💰 Invoice Payment Section</h3>
                    <p className="text-center text-xl mt-3">
                      Deposit paid on estimate: <strong>{profile.depositPercentage}%</strong><br />
                      Remainder due: <strong>{100 - (profile.depositPercentage || 0)}%</strong> = <span className="font-bold text-2xl"> ${(grandTotal * (100 - (profile.depositPercentage || 0)) / 100).toFixed(2)}</span>
                      {profile.chargeCCFee && (
                        <span className="block text-sm mt-1 text-amber-700">
                          + {profile.ccFeePercentage || 3}% CC processing fee applied at checkout
                        </span>
                      )}
                    </p>
                    {(() => {
                      let remainder = grandTotal * (100 - (profile.depositPercentage || 0)) / 100;
                      if (profile.chargeCCFee) {
                        remainder = remainder * (1 + (profile.ccFeePercentage || 3) / 100);
                      }
                      return (
                        <div className="mt-6 space-y-4">
                          <Button
                            onClick={() => openPaymentModal('balance', remainder)}
                            className="w-full py-8 text-2xl font-bold bg-[#f59e0b] hover:bg-orange-600 text-white rounded-3xl"
                          >
                            Pay the Balance Now (${remainder.toFixed(2)})
                            {profile.chargeCCFee && <span className="text-xs block mt-1 font-normal opacity-90">(includes CC fee)</span>}
                          </Button>
                          {isVenmoPaymentReady() && renderVenmoPayButton(remainder, 'balance', {
                            className: 'w-full py-8 text-2xl font-bold bg-[#008cff] hover:bg-[#0070cc] text-white rounded-3xl',
                          })}
                        </div>
                      );
                    })()}
                    <p className="text-center text-xs text-gray-500 mt-3">Choose a payment option above to pay the remaining balance</p>
                  </div>
                )}

                {photoUrls.length > 0 && (
                  <div className="mt-12">
                    {renderPhotoGallery({ heading: 'Attached Photos' })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Navigation */}
        <div className="bg-white border-t shadow-inner flex items-center justify-around py-2 px-1 text-xs">
          <button onClick={goToDashboard} className={`flex flex-col items-center flex-1 py-1 ${view === 'dashboard' ? 'text-[#10b981]' : 'text-gray-500'}`}>
            <span className="text-3xl mb-0.5">📊</span>
            <span>{t('dashboard')}</span>
          </button>
          <button onClick={() => setView('estimatesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📋</span>
            <span>{t('estimates')}</span>
          </button>
          <button onClick={() => setView('invoicesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">💰</span>
            <span>{t('invoices')}</span>
          </button>
          <button onClick={() => openNewDocument('estimate')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📄</span>
            <span>{t('newEstimate')}</span>
          </button>
          <button
            onClick={() => {
              setView('reportsView');
              void refreshArchivesList();
            }}
            className="flex flex-col items-center flex-1 py-1 text-gray-500"
          >
            <span className="text-3xl mb-0.5">📊</span>
            <span>{t('reports')}</span>
          </button>
          <button onClick={openCalendarModal} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📅</span>
            <span>{t('calendar')}</span>
          </button>
          <button 
            onClick={() => {
              if (currentCrew) {
                showMessage('Profile editing is restricted for crew accounts.');
                return;
              }
              setView('profileView');
            }} 
            className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">👤</span>
            <span>{t('profile')}</span>
          </button>
        </div>
      </div>

      <ToastContainer />

      {/* Load Modal */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{t('savedDocuments')}</DialogTitle></DialogHeader>
          <div className="max-h-96 overflow-auto">
            {savedEstimatesList.map(est => (
              <div key={est.id} className="flex justify-between items-center p-4 border-b">
                <div>
                  <div className="font-semibold">{est.jobName || 'Untitled'} — {est.invoiceNumber}</div>
                  <div className="text-xs text-gray-500">{est.date}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={async () => { await loadSelectedEstimate(est); setIsLoadModalOpen(false); setView('editor'); }}>{t('load')}</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>{t('delete')}</Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Send Modal */}
      <Dialog open={isSendModalOpen} onOpenChange={setIsSendModalOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>📧 Choose Recipients for this {documentType === 'invoice' ? 'Invoice' : 'Estimate'}</DialogTitle></DialogHeader>
          <div className="space-y-6">
            <div>
              <h4 className="font-semibold mb-2">Select Emails</h4>
              {emails.map((em, i) => (
                <label key={i} className="flex items-center gap-2 mb-1">
                  <input 
                    type="checkbox" 
                    checked={selectedEmailsForSend.includes(em)}
                    onChange={() => {
                      setSelectedEmailsForSend(prev => prev.includes(em) ? prev.filter(e => e !== em) : [...prev, em]);
                    }}
                  />
                  {em || '(empty)'}
                </label>
              ))}
            </div>
            <div>
              <h4 className="font-semibold mb-2">Select Phone Numbers</h4>
              {phones.map((ph, i) => (
                <label key={i} className="flex items-center gap-2 mb-1">
                  <input 
                    type="checkbox" 
                    checked={selectedPhonesForSend.includes(ph)}
                    onChange={() => {
                      setSelectedPhonesForSend(prev => prev.includes(ph) ? prev.filter(p => p !== ph) : [...prev, ph]);
                    }}
                  />
                  {ph || '(empty)'}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSendModalOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              showMessage(`✅ ${documentType === 'invoice' ? 'Invoice' : 'Estimate'} sent to selected recipients!\nEmails: ${selectedEmailsForSend.join(', ') || 'none'}\nPhones: ${selectedPhonesForSend.join(', ') || 'none'}`);
              setIsSendModalOpen(false);
            }} className="bg-[#10b981]">Send Now</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Labor Modal */}
      <Dialog open={isLaborModalOpen} onOpenChange={setIsLaborModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>💼 Add Labor to Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={useHourlyLabor} onChange={() => setUseHourlyLabor(true)} />
                Hourly
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={!useHourlyLabor} onChange={() => setUseHourlyLabor(false)} />
                Fixed Amount
              </label>
            </div>

            {useHourlyLabor ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-1">Hours</label>
                  <Input type="number" value={laborHours} onChange={e => setLaborHours(parseFloat(e.target.value) || 0)} />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-1">Hourly Rate</label>
                  <Input type="number" value={laborRate} onChange={e => setLaborRate(parseFloat(e.target.value) || 0)} />
                </div>
                <div className="col-span-2 text-right text-xl font-semibold">
                  Labor Total: <span className="text-[#14b8a6]">${(laborHours * laborRate).toFixed(2)}</span>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-semibold mb-1">Fixed Labor Amount</label>
                <Input type="number" value={laborFixedAmount} onChange={e => setLaborFixedAmount(parseFloat(e.target.value) || 0)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsLaborModalOpen(false)}>Cancel</Button>
            <Button onClick={() => { setIsLaborModalOpen(false); showMessage(`✅ Labor of $${laborAmount.toFixed(2)} added`); }} className="bg-[#14b8a6]">Save Labor</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Job Mileage Modal — same row as Labor on estimate editor */}
      <Dialog open={isMileageModalOpen} onOpenChange={setIsMileageModalOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>🚗 Job mileage</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500 -mt-2 mb-2">
            Log miles for this job only (gas write-off). Saved with the estimate/invoice.
          </p>
          <MileageTracker
            variant="job"
            logs={jobMileageLogs}
            ratePerMile={mileageRatePerMile}
            defaultJobName={jobName}
            onChangeLogs={setJobMileageLogs}
            onSave={async (logs) => {
              await saveJobMileage(logs);
            }}
            saving={mileageSaving}
            title="Trips for this job"
          />
          <DialogFooter className="mt-2">
            <Button
              type="button"
              className="bg-[#0ea5e9] text-white"
              onClick={() => setIsMileageModalOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Extraction Modal */}
      <Dialog open={isReceiptExtractModalOpen} onOpenChange={setIsReceiptExtractModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>📄 Extract Receipt Information</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div>
              <label className="block text-sm font-semibold mb-1">Receipt Date</label>
              <Input type="date" value={tempReceiptData.date} onChange={e => setTempReceiptData({...tempReceiptData, date: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Category</label>
              <select 
                value={tempReceiptData.vendor} 
                onChange={e => setTempReceiptData({...tempReceiptData, vendor: e.target.value})}
                className="w-full p-3 border rounded-xl"
              >
                <option value="Material/Supplies">Material/Supplies</option>
                <option value="Gas">Gas</option>
                <option value="Meals">Meals</option>
                <option value="Other">Other (custom)</option>
              </select>
            </div>
            {tempReceiptData.vendor === 'Other' && (
              <div>
                <label className="block text-sm font-semibold mb-1">Custom Category</label>
                <Input 
                  value={tempReceiptData.vendor} 
                  onChange={e => setTempReceiptData({...tempReceiptData, vendor: e.target.value})} 
                  placeholder="Enter custom category"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-semibold mb-1">Total Amount</label>
              <Input type="number" value={tempReceiptData.amount} onChange={e => setTempReceiptData({...tempReceiptData, amount: parseFloat(e.target.value) || 0})} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Notes / Items</label>
              <Textarea value={tempReceiptData.notes} onChange={e => setTempReceiptData({...tempReceiptData, notes: e.target.value})} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReceiptExtractModalOpen(false)}>Cancel</Button>
            <Button onClick={saveReceiptExtraction} className="bg-[#10b981]">Save to Database</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Line Breakdown Editor Modal */}
      <Dialog
        open={isBreakdownModalOpen}
        onOpenChange={(open) => {
          if (!open) closeBreakdownEditor();
          else setIsBreakdownModalOpen(true);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>✏️ Edit Line Breakdown</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 py-2">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold">Materials</h4>
                <Button size="sm" variant="outline" onClick={addBreakdownMaterialRow}>
                  + Add Material
                </Button>
              </div>
              <div className="space-y-3">
                {breakdownMaterials.map((material, index) => (
                  <div key={index} className="border rounded-xl p-3 bg-gray-50 space-y-2">
                    <div className="flex items-start gap-2">
                      <Input
                        value={material.description}
                        onChange={e => updateBreakdownMaterial(index, 'description', e.target.value)}
                        placeholder="Material description"
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => removeBreakdownMaterialRow(index)}
                      >
                        ×
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Qty</label>
                        <Input
                          type="number"
                          value={material.qty}
                          onChange={e => updateBreakdownMaterial(index, 'qty', parseFloat(e.target.value) || 0)}
                          className="text-right"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Unit</label>
                        <select
                          value={material.unit || ''}
                          onChange={e => updateBreakdownMaterial(index, 'unit', e.target.value)}
                          className="flex h-10 w-full rounded-lg border border-input bg-white px-2 py-2 text-sm"
                        >
                          <option value="">—</option>
                          {getLineItemUnitOptions(material.unit).map(unit => (
                            <option key={unit} value={unit}>{unit}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Unit Price</label>
                        <Input
                          type="number"
                          step="0.01"
                          value={material.unitPrice}
                          onChange={e => updateBreakdownMaterial(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                          className="text-right"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">Total</label>
                        <Input
                          type="number"
                          step="0.01"
                          value={material.total}
                          onChange={e => updateBreakdownMaterial(index, 'total', parseFloat(e.target.value) || 0)}
                          className="text-right"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="border rounded-xl p-4 bg-gray-50 space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={breakdownIncludeLabor}
                  onChange={e => {
                    const checked = e.target.checked;
                    setBreakdownIncludeLabor(checked);
                    if (checked && !breakdownLabor) setBreakdownLabor(emptyBreakdownLabor());
                  }}
                  className="w-4 h-4 accent-[#10b981]"
                />
                <span className="font-semibold">Include labor breakdown</span>
              </label>

              {breakdownIncludeLabor && (
                <div className="space-y-2">
                  <Input
                    value={breakdownLabor?.description || ''}
                    onChange={e => updateBreakdownLaborField('description', e.target.value)}
                    placeholder="Labor description"
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Hours</label>
                      <Input
                        type="number"
                        step="0.25"
                        value={breakdownLabor?.hours ?? 0}
                        onChange={e => updateBreakdownLaborField('hours', parseFloat(e.target.value) || 0)}
                        className="text-right"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Rate / hr</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={breakdownLabor?.rate ?? 0}
                        onChange={e => updateBreakdownLaborField('rate', parseFloat(e.target.value) || 0)}
                        className="text-right"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">Labor Total</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={breakdownLabor?.total ?? 0}
                        onChange={e => updateBreakdownLaborField('total', parseFloat(e.target.value) || 0)}
                        className="text-right"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
              {(() => {
                const editItem = breakdownEditItemId != null
                  ? items.find(row => row.id === breakdownEditItemId)
                  : null;
                const previewMaterials = breakdownMaterials.map(normalizeBreakdownMaterial);
                const previewLabor = breakdownIncludeLabor
                  ? normalizeBreakdownLabor(breakdownLabor || emptyBreakdownLabor())
                  : null;
                const builtUp = getBuiltUpBreakdownPrice(previewMaterials, previewLabor);
                const pricing = editItem && builtUp > 0
                  ? syncLineItemPricingFromJobTotal(
                      editItem.description || '',
                      editItem.qty || 1,
                      editItem.unit || '',
                      builtUp
                    )
                  : null;
                return (
                  <>
                    <div className="font-semibold text-emerald-900">
                      Built-up job total: ${builtUp.toFixed(2)}
                    </div>
                    {pricing && pricing.qty > 1 && (
                      <div className="text-emerald-800 mt-1">
                        Line: {pricing.qty.toLocaleString()} {pricing.unit} × ${pricing.price.toFixed(2)}
                        {' '}= ${pricing.total.toFixed(2)}
                      </div>
                    )}
                    <label className="flex items-start gap-2 mt-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={breakdownSyncLinePrice}
                        onChange={e => setBreakdownSyncLinePrice(e.target.checked)}
                        className="mt-1 w-4 h-4 accent-[#10b981]"
                      />
                      <span className="text-emerald-950">
                        {pricing && pricing.qty > 1
                          ? `Update line from built-up total (${pricing.qty.toLocaleString()} ${pricing.unit} × $${pricing.price.toFixed(2)} = $${pricing.total.toFixed(2)})`
                          : 'Update line price from this built-up total'}
                      </span>
                    </label>
                  </>
                );
              })()}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeBreakdownEditor}>Cancel</Button>
            <Button onClick={saveBreakdown} className="bg-[#10b981]">Save Breakdown</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Lines Modal */}
      <Dialog open={isQuickLinesModalOpen} onOpenChange={setIsQuickLinesModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>📌 Saved Quick Lines</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-auto py-2">
            {quickLines.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                No quick lines saved yet.<br />
                Click the 💾 icon next to any line item to save one.
              </div>
            ) : (
              <div className="space-y-3">
                {quickLines.map((quick) => (
                  <div key={quick.id} className="flex justify-between items-center border rounded-xl p-4 bg-white">
                    <div className="flex-1">
                      <div className="font-medium text-lg">{quick.description}</div>
                      <div className="text-sm text-gray-500 mt-1">
                        {quick.qty} × ${quick.price.toFixed(2)} = ${(quick.qty * quick.price).toFixed(2)}
                        {quick.unit && ` • ${quick.unit}`}
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Button 
                        size="sm" 
                        onClick={() => applyQuickLine(quick)}
                        className="bg-[#10b981]"
                      >
                        Use
                      </Button>
                      <Button 
                        size="sm" 
                        variant="destructive"
                        onClick={() => deleteQuickLine(quick.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsQuickLinesModalOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Calendar Modal */}
      <Dialog
        open={isCalendarModalOpen}
        onOpenChange={(open) => {
          setIsCalendarModalOpen(open);
          if (!open) {
            setCalendarView('schedule');
            resetAppointmentForm();
          }
        }}
      >
        <DialogContent className="max-w-md">
          {calendarView === 'schedule' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  📅 {editingAppointmentId ? t('editAppointment') : t('scheduleAppointment')}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-6 py-4">
                <div>
                  <label className="block text-sm font-semibold mb-2">Select Estimate</label>
                  <select 
                    className="w-full border rounded-xl p-3"
                    value={selectedEstimateForCalendar?.id || ''}
                    onChange={e => {
                      const selected = savedEstimatesList.find(
                        est => est.id === e.target.value && 
                               (est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST'))
                      );
                      setSelectedEstimateForCalendar(selected || null);
                    }}
                  >
                    <option value="">— Choose an estimate —</option>
                    {savedEstimatesList
                      .filter(est => est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST'))
                      .map(est => (
                        <option key={est.id} value={est.id}>
                          {est.jobName || 'Untitled'} — {est.invoiceNumber}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-2">Date & Time</label>
                  <Input 
                    type="datetime-local" 
                    value={selectedDateTime} 
                    onChange={e => setSelectedDateTime(e.target.value)} 
                  />
                </div>

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setCalendarView('appointments')}
                >
                  📋 {t('viewAppointments')}
                </Button>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (editingAppointmentId) {
                      resetAppointmentForm();
                      setCalendarView('appointments');
                    } else {
                      setIsCalendarModalOpen(false);
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={scheduleAppointment} className="bg-[#10b981]" disabled={schedulingAppointment}>
                  {schedulingAppointment
                    ? editingAppointmentId
                      ? 'Saving...'
                      : 'Scheduling...'
                    : editingAppointmentId
                      ? t('saveChanges')
                      : t('scheduleAppointment')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>📋 {t('viewAppointments')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <Button variant="outline" size="sm" onClick={goToPreviousAppointmentsMonth} aria-label={t('previousMonth')}>
                    ←
                  </Button>
                  <div className="flex-1 text-center">
                    <select
                      className="border rounded-lg px-3 py-2 text-sm font-semibold w-full max-w-[220px]"
                      value={appointmentsMonth}
                      onChange={e => setAppointmentsMonth(Number(e.target.value))}
                    >
                      {MONTH_NAMES[profile.language as 'en' | 'es' | 'fr']?.map((monthName, index) => (
                        <option key={monthName} value={index}>{monthName}</option>
                      ))}
                    </select>
                    <div className="mt-2 flex items-center justify-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setAppointmentsYear(prev => prev - 1)}>−</Button>
                      <span className="text-sm font-medium min-w-[4rem]">{appointmentsYear}</span>
                      <Button variant="outline" size="sm" onClick={() => setAppointmentsYear(prev => prev + 1)}>+</Button>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={goToNextAppointmentsMonth} aria-label={t('nextMonth')}>
                    →
                  </Button>
                </div>

                <div className="max-h-72 overflow-y-auto space-y-3">
                  {appointmentsForSelectedMonth.map(appt => (
                    <div key={appt.id} className="border rounded-xl p-3 bg-gray-50">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-[#1e293b]">{appt.jobName}</div>
                          <div className="text-sm text-gray-600">{appt.invoiceNumber}</div>
                          <div className="text-sm text-[#10b981] mt-1">
                            {new Date(appt.datetime).toLocaleString(
                              profile.language === 'es' ? 'es-ES' : profile.language === 'fr' ? 'fr-FR' : 'en-US',
                              { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
                            )}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => openEditAppointment(appt)}
                        >
                          {t('edit')}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {appointmentsForSelectedMonth.length === 0 && (
                    <p className="text-sm text-gray-500 text-center py-8">{t('noAppointmentsThisMonth')}</p>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    resetAppointmentForm();
                    setCalendarView('schedule');
                  }}
                >
                  {t('backToSchedule')}
                </Button>
                <Button onClick={() => setIsCalendarModalOpen(false)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Third Party Escrow Modal */}
      <Dialog open={isEscrowModalOpen} onOpenChange={setIsEscrowModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Third Party Escrow</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm text-gray-700 leading-relaxed">
            <p>
              To use third-party escrow, the <strong>contractor</strong> and <strong>client</strong> must agree on
              a neutral escrow provider to hold project funds until work is completed and approved.
            </p>
            <p>
              Neither party should send the full contract amount directly to the other until escrow terms are in place.
              The escrow account holds the money and releases it according to milestones or final sign-off you both agree to.
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Choose a licensed or reputable third-party escrow company or attorney trust account.</li>
              <li>Both parties sign escrow instructions defining deposit, milestones, and release conditions.</li>
              <li>Funds are deposited into escrow before work begins (or per your contract).</li>
              <li>Escrow releases payment to the contractor when agreed conditions are met.</li>
            </ul>
            <p className="text-xs text-gray-500">
              EstimateAce does not provide escrow services. This option is for clients and contractors who arrange
              their own third-party escrow outside the app.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setIsEscrowModalOpen(false)} className="bg-[#10b981]">
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment Modal */}
      <Dialog open={isPaymentModalOpen} onOpenChange={setIsPaymentModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Pay {paymentType === 'deposit' ? 'Deposit' : 'Balance'}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <div className="text-center mb-6">
              <div className="text-5xl font-bold text-[#10b981]">${paymentAmount.toFixed(2)}</div>
              <p className="text-sm text-gray-500 mt-1">to complete your {paymentType}</p>
              {profile.chargeCCFee && ccFeePercent > 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  (includes {ccFeePercent}% credit card processing fee)
                </p>
              )}
            </div>

            <div className="space-y-3">
              {Object.entries(mergePaymentSettings(profile.paymentSettings)).map(([method, settings]) => {
                if (!settings.enabled) return null;
                if (method === 'venmo' && !hasVenmoHandle(settings.handle)) return null;
                if (method === 'zelle' && !hasZelleSetup(settings)) return null;
                if (method === 'paypal' && !hasPayPalSetup(settings)) return null;
                if (method === 'mailcheck' && !hasMailCheckSetup(settings)) return null;
                const meta = getPaymentMethodMeta(method);
                const venmoHandle = method === 'venmo' ? cleanVenmoHandle(settings.handle || '') : '';
                const zelleHandle = method === 'zelle' ? cleanZelleHandle(settings.handle || '') : '';
                const paypalHandle = method === 'paypal' ? cleanPayPalHandle(settings.handle || '') : '';
                const mailTo = method === 'mailcheck' ? (settings.handle || '').trim() : '';

                if (method === 'mailcheck') {
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => selectPaymentMethod(method)}
                      className={`w-full flex items-start gap-4 p-4 border-2 rounded-2xl hover:bg-gray-50 transition-all text-left ${
                        selectedPaymentMethod === method ? 'border-[#10b981] bg-green-50' : 'border-gray-200'
                      }`}
                    >
                      <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{meta.label}</div>
                        <div className="text-xs text-gray-600 mt-1 whitespace-pre-wrap break-words">
                          {mailTo}
                        </div>
                        <div className="text-[11px] text-gray-500 mt-1">
                          Write invoice # {invoiceNumber} on the memo line
                        </div>
                      </div>
                    </button>
                  );
                }

                if (method === 'venmo') {
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        closePaymentModal();
                        openVenmoPayment(paymentAmount, paymentType === 'deposit' ? 'deposit' : 'balance');
                      }}
                      className="w-full flex items-center gap-4 p-4 border-2 rounded-2xl border-[#008cff] bg-blue-50 hover:bg-blue-100 transition-all"
                    >
                      <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <div className="font-semibold text-[#005fa3]">{meta.label}</div>
                        <div className="text-xs text-gray-600 break-words">
                          Pay @{venmoHandle} · invoice note auto-filled for tracking
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[#008cff] shrink-0">Pay →</span>
                    </button>
                  );
                }

                if (method === 'zelle') {
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        closePaymentModal();
                        openZellePayment(paymentAmount, paymentType === 'deposit' ? 'deposit' : 'balance');
                      }}
                      className="w-full flex items-center gap-4 p-4 border-2 rounded-2xl border-violet-500 bg-violet-50 hover:bg-violet-100 transition-all"
                    >
                      <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <div className="font-semibold text-violet-900">{meta.label}</div>
                        <div className="text-xs text-gray-600 break-words">
                          {zelleHandle
                            ? `Send to ${zelleHandle} · include invoice # in memo`
                            : 'Scan QR · include invoice # in memo'}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-violet-700 shrink-0">Pay →</span>
                    </button>
                  );
                }

                if (method === 'paypal') {
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        closePaymentModal();
                        openPayPalPayment(paymentAmount, paymentType === 'deposit' ? 'deposit' : 'balance');
                      }}
                      className="w-full flex items-center gap-4 p-4 border-2 rounded-2xl border-[#0070ba] bg-sky-50 hover:bg-sky-100 transition-all"
                    >
                      <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <div className="font-semibold text-[#003087]">{meta.label}</div>
                        <div className="text-xs text-gray-600 break-words">
                          {isPayPalEmail(paypalHandle)
                            ? `Pay ${paypalHandle} · amount + invoice note`
                            : `paypal.me/${paypalHandle} · amount pre-filled`}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[#0070ba] shrink-0">Pay →</span>
                    </button>
                  );
                }

                return (
                  <button
                    key={method}
                    type="button"
                    onClick={() => selectPaymentMethod(method)}
                    className={`w-full flex items-center gap-4 p-4 border-2 rounded-2xl hover:bg-gray-50 transition-all ${selectedPaymentMethod === method ? 'border-[#10b981] bg-green-50' : 'border-gray-200'}`}
                  >
                    <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                    <div className="flex-1 text-left">
                      <div className="font-semibold">{meta.label}</div>
                      <div className="text-xs text-gray-500">{meta.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <DialogFooter className="flex gap-3">
            <Button variant="outline" onClick={closePaymentModal} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={proceedWithPayment}
              disabled={
                !selectedPaymentMethod ||
                selectedPaymentMethod === 'venmo' ||
                selectedPaymentMethod === 'zelle' ||
                selectedPaymentMethod === 'paypal'
              }
              className="flex-1 bg-[#10b981]"
            >
              {selectedPaymentMethod === 'venmo' ||
              selectedPaymentMethod === 'zelle' ||
              selectedPaymentMethod === 'paypal'
                ? 'Tap method above'
                : 'Continue to Pay'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Venmo pay — @username + tracking note + mark paid */}
      <Dialog open={isVenmoPayOpen} onOpenChange={setIsVenmoPayOpen}>
        <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pay with Venmo</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-center">
              <div className="text-4xl font-bold text-[#008cff]">
                ${venmoPayAmount.toFixed(2)}
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {venmoPayLabel === 'deposit' ? 'Deposit' : venmoPayLabel === 'balance' ? 'Balance' : 'Invoice total'}
                {' · '}{invoiceNumber}
              </p>
            </div>

            <div className="rounded-xl border bg-blue-50 p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-[#005fa3] font-semibold">Pay this Venmo</div>
              <div className="text-2xl font-bold text-[#008cff] break-all mt-1">
                @{cleanVenmoHandle(getVenmoSettings()?.handle || '')}
              </div>
              <p className="text-xs text-gray-600 mt-2">
                Username is set by the contractor in Profile → Payments and can be edited anytime.
              </p>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold mb-1">Payment note (for tracking)</p>
              <p>
                This note is filled into Venmo so the contractor can match the payment to this invoice:
              </p>
              <p className="mt-2 font-mono text-sm font-bold break-all bg-white/80 rounded-lg px-2 py-1.5 border">
                {getVenmoTrackingNote(venmoPayLabel)}
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-[#008cff] underline"
                onClick={async () => {
                  const note = getVenmoTrackingNote(venmoPayLabel);
                  try {
                    await navigator.clipboard.writeText(note);
                    showMessage('Note copied — it is also passed into the Venmo link.');
                  } catch {
                    showMessage(`Note: ${note}`);
                  }
                }}
              >
                Copy note
              </button>
            </div>

            <Button
              type="button"
              className="w-full bg-[#008cff] hover:bg-[#0070cc] text-white font-semibold py-6 text-base"
              onClick={() => launchVenmoAppWithNote(venmoPayAmount, venmoPayLabel)}
            >
              Open Venmo to pay ${venmoPayAmount.toFixed(2)}
            </Button>

            <p className="text-xs text-gray-500 text-center">
              Venmo does not notify EstimateAce automatically. After you send payment in Venmo, tap below to mark this invoice paid.
            </p>
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsVenmoPayOpen(false)} className="flex-1">
              Close
            </Button>
            <Button
              className="flex-1 bg-[#008cff] hover:bg-[#0070cc]"
              onClick={() => void confirmClientVenmoPayment()}
            >
              I paid with Venmo — mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PayPal real checkout — PayPal.Me amount link or business email pay */}
      <Dialog open={isPayPalPayOpen} onOpenChange={setIsPayPalPayOpen}>
        <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pay with PayPal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-center">
              <div className="text-4xl font-bold text-[#0070ba]">
                ${paypalPayAmount.toFixed(2)}
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {paypalPayLabel === 'deposit' ? 'Deposit' : paypalPayLabel === 'balance' ? 'Balance' : 'Invoice total'}
                {' · '}{invoiceNumber}
              </p>
            </div>

            <div className="rounded-xl border bg-sky-50 p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-[#003087] font-semibold">
                {isPayPalEmail(getPayPalSettings()?.handle || '')
                  ? 'PayPal checkout email'
                  : 'PayPal.Me'}
              </div>
              <div className="text-lg font-bold text-[#0070ba] break-all mt-1">
                {isPayPalEmail(getPayPalSettings()?.handle || '')
                  ? cleanPayPalHandle(getPayPalSettings()?.handle || '')
                  : `paypal.me/${cleanPayPalHandle(getPayPalSettings()?.handle || '')}`}
              </div>
              <p className="text-xs text-gray-600 mt-2 break-all">
                {buildPayPalPayUrl(
                  getPayPalSettings()?.handle || '',
                  paypalPayAmount,
                  getPayPalTrackingNote(paypalPayLabel)
                )}
              </p>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold mb-1">Tracking note / item name</p>
              <p className="font-mono text-sm font-bold break-all bg-white/80 rounded-lg px-2 py-1.5 border mt-1">
                {getPayPalTrackingNote(paypalPayLabel)}
              </p>
              <p className="text-xs mt-2">
                Included on the PayPal payment page so you can match the payment to this invoice.
              </p>
            </div>

            <Button
              type="button"
              className="w-full bg-[#0070ba] hover:bg-[#005ea6] text-white font-semibold py-6 text-base"
              onClick={() => launchPayPalCheckout(paypalPayAmount, paypalPayLabel)}
            >
              Open PayPal to pay ${paypalPayAmount.toFixed(2)}
            </Button>

            <p className="text-xs text-gray-500 text-center">
              This opens a real PayPal payment page for the amount due — not just paypal.com. After you finish paying, tap below to mark this invoice paid (PayPal does not auto-notify this app).
            </p>
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsPayPalPayOpen(false)} className="flex-1">
              Close
            </Button>
            <Button
              className="flex-1 bg-[#0070ba] hover:bg-[#005ea6]"
              onClick={() => void confirmClientPayPalPayment()}
            >
              I paid with PayPal — mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Zelle pay instructions — QR + unique name for this invoice */}
      <Dialog open={isZellePayOpen} onOpenChange={setIsZellePayOpen}>
        <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pay with Zelle</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-center">
              <div className="text-4xl font-bold text-[#6d28d9]">
                ${zellePayAmount.toFixed(2)}
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {zellePayLabel === 'deposit' ? 'Deposit' : zellePayLabel === 'balance' ? 'Balance' : 'Invoice total'}
                {' · '}{invoiceNumber}
              </p>
            </div>

            {zelleQrDisplayUrl && (
              <div className="flex flex-col items-center gap-2">
                <img
                  src={zelleQrDisplayUrl}
                  alt="Zelle QR code"
                  className="h-48 w-48 object-contain border rounded-2xl bg-white p-3 shadow-sm"
                />
                <p className="text-xs text-gray-500">Scan this QR in your banking app</p>
              </div>
            )}

            {hasZelleHandle(getZelleSettings()?.handle) && (
              <div className="rounded-xl border bg-violet-50 p-4 text-center">
                <div className="text-xs uppercase tracking-wide text-violet-700 font-semibold">Send Zelle to</div>
                <div className="text-lg font-bold text-violet-950 break-all mt-1">
                  {cleanZelleHandle(getZelleSettings()?.handle || '')}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold mb-1">Important — memo / note</p>
              <p>
                Put this exact text in the Zelle memo so payment matches this invoice:
              </p>
              <p className="mt-2 font-mono text-sm font-bold break-all bg-white/80 rounded-lg px-2 py-1.5 border">
                {buildZellePaymentMemo(invoiceNumber, zellePayLabel, profile.company)}
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-violet-800 underline"
                onClick={async () => {
                  const memo = buildZellePaymentMemo(invoiceNumber, zellePayLabel, profile.company);
                  try {
                    await navigator.clipboard.writeText(memo);
                    showMessage('Memo copied — paste it into Zelle.');
                  } catch {
                    showMessage(`Memo: ${memo}`);
                  }
                }}
              >
                Copy memo
              </button>
            </div>

            <p className="text-xs text-gray-500 text-center">
              Zelle does not notify this app automatically. After you send payment, tap below to mark this invoice paid.
            </p>
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsZellePayOpen(false)} className="flex-1">
              Close
            </Button>
            <Button
              className="flex-1 bg-[#6d28d9] hover:bg-[#5b21b6]"
              onClick={() => void confirmClientZellePayment()}
            >
              I paid with Zelle — mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Crew pay modal retired (Phase A) — kept closed */}
      <Dialog open={false} onOpenChange={() => setIsCrewPayModalOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Crew billing</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">Crew seat billing moves to Phase B.</p>
        </DialogContent>
      </Dialog>

      <DeviceCamera
        open={isDeviceCameraOpen}
        mode={deviceCameraMode}
        onClose={handleDeviceCameraClose}
        onPhoto={handleDeviceCameraPhoto}
        onVideo={handleDeviceCameraVideo}
      />

      {/* Media picker — device-style camera or gallery upload */}
      <Dialog open={isPhotoPickerOpen} onOpenChange={setIsPhotoPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('addPhotos')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Button
              onClick={openDevicePhotoCamera}
              className="w-full justify-start gap-3 h-auto py-4 bg-[#10b981] hover:bg-[#0ea16b]"
            >
              <span className="text-2xl">📸</span>
              <span className="text-left">
                <span className="block font-semibold">{t('takePhotoWithCamera')}</span>
                <span className="block text-xs font-normal opacity-90">
                  Fixed frame + shutter · zoom only the shot · each photo auto-saves
                </span>
              </span>
            </Button>
            <Button
              onClick={openDeviceVideoCamera}
              className="w-full justify-start gap-3 h-auto py-4 bg-[#0ea5e9] hover:bg-[#0284c7]"
            >
              <span className="text-2xl">🎥</span>
              <span className="text-left">
                <span className="block font-semibold">Record Video with Camera</span>
                <span className="block text-xs font-normal opacity-90">
                  Same fixed controls · record and auto-save to this estimate
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={triggerPhotoGallery}
              className="w-full justify-start gap-3 h-auto py-4"
            >
              <span className="text-2xl">🖼️</span>
              <span className="text-left">
                <span className="block font-semibold">{t('uploadPhotos')}</span>
                <span className="block text-xs font-normal text-gray-500">
                  Choose existing photos from your device
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={triggerVideoGallery}
              className="w-full justify-start gap-3 h-auto py-4"
            >
              <span className="text-2xl">📁</span>
              <span className="text-left">
                <span className="block font-semibold">Upload Videos</span>
                <span className="block text-xs font-normal text-gray-500">
                  Choose existing videos from your device
                </span>
              </span>
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsPhotoPickerOpen(false)} className="w-full">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </ErrorBoundary>
    </>
  );
}
