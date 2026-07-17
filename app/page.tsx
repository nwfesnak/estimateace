'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TouchDoubleTapTextarea } from '@/components/TouchDoubleTapTextarea';
import { DeviceCamera, type DeviceCameraMode } from '@/components/DeviceCamera';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { getSupabaseClient, getSupabaseConfigHelpMessage } from '@/lib/supabase/client';
import { isMediaPdfRef, resolveMediaDisplayUrl } from '@/lib/media-url';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { getLineItemUnitOptions, LINE_ITEM_UNITS } from '@/lib/quote-units';
import {
  cleanVenmoHandle,
  hasVenmoHandle,
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
  nowpayments: { enabled: false, connected: false },
  coinbase_commerce: { enabled: false, connected: false },
};

const CRYPTO_PAYMENT_METHODS = new Set(['nowpayments', 'coinbase_commerce']);

const getPaymentMethodMeta = (method: string) => {
  const meta: Record<string, { icon: string; label: string; description: string; category: 'traditional' | 'crypto' }> = {
    stripe: { icon: '💳', label: 'Stripe', description: 'Cards, Apple Pay, Google Pay', category: 'traditional' },
    echeck: { icon: '🏦', label: 'eCheck / ACH', description: 'Bank account (ACH)', category: 'traditional' },
    paypal: { icon: '💰', label: 'PayPal', description: 'PayPal balance or card', category: 'traditional' },
    venmo: { icon: '📱', label: 'Venmo', description: 'Mobile app payment', category: 'traditional' },
    zelle: { icon: '🏦', label: 'Zelle', description: 'Bank-to-bank transfer', category: 'traditional' },
    nowpayments: { icon: '₿', label: 'NOWPayments', description: 'Bitcoin, Ethereum, and 300+ cryptocurrencies', category: 'crypto' },
    coinbase_commerce: { icon: '🪙', label: 'Coinbase Commerce', description: 'Crypto checkout via Coinbase Commerce', category: 'crypto' },
  };
  return meta[method] || { icon: '💳', label: method, description: 'Payment provider', category: 'traditional' };
};

const mergePaymentSettings = (settings?: Record<string, PaymentMethodSettings>) => {
  const merged: Record<string, { enabled: boolean; connected: boolean; handle?: string }> = {};
  for (const [key, defaults] of Object.entries(DEFAULT_PAYMENT_SETTINGS)) {
    const saved = settings?.[key];
    merged[key] = {
      enabled: saved?.enabled ?? defaults.enabled,
      connected: key === 'venmo' ? false : (saved?.connected ?? defaults.connected),
      handle: saved?.handle,
    };
  }
  if (settings) {
    for (const [key, saved] of Object.entries(settings)) {
      if (!merged[key]) {
        merged[key] = {
          enabled: !!saved?.enabled,
          connected: !!saved?.connected,
          handle: saved?.handle,
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
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView' | 'archivesView' | 'sendPreview' | 'reportsView'>('dashboard');

  // Login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  // Crew / Sub login
  const [crewLoginEmail, setCrewLoginEmail] = useState('');
  const [crewLoginPassword, setCrewLoginPassword] = useState('');
  const [currentCrew, setCurrentCrew] = useState<any>(null);

  // Forgot password states
  const [showMainForgot, setShowMainForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [showCrewForgot, setShowCrewForgot] = useState(false);
  const [crewForgotEmail, setCrewForgotEmail] = useState('');

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

  // Profile (with payment settings)
  const [profile, setProfile] = useState({
    name: '', company: '', address: '', phone: '', email: '', slogan: '',
    city: '', state: '', zipCode: '',
    disclosure: '',
    certificateUrl: '',
    logoUrl: '',
    logoSize: 'medium',
    language: 'en',
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
    teammates: [] as { email: string; role: 'full' | 'limited'; canSeePricing: boolean; canSeeEstimatesAndFinancials: boolean }[], // NOTE: No password stored for security (was demo-only plaintext)
    crewSubscriptionActive: false,
    chargeCCFee: false,
    ccFeePercentage: 3,
    paymentSettings: { ...DEFAULT_PAYMENT_SETTINGS } as any
  });

  // Language / i18n (must be after profile is declared)
  // Prefer localStorage (user's explicit choice) so language never reverts on load/new/open
  const currentLang = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('appLanguage');
      if (saved && ['en', 'es', 'fr'].includes(saved)) return saved;
    }
    return ((profile as any).language || 'en');
  })();
  const t = (key: string): string => {
    return (translations as any)[currentLang]?.[key] || (translations as any)['en']?.[key] || key;
  };

  const [profileTab, setProfileTab] = useState<'info' | 'payments'>('info');
  /** Skip profile auto-save while hydrating from server/local cache */
  const profileHydratingRef = useRef(false);
  const profileAutoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedCompanyFingerprintRef = useRef('');
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [profileAutoSaveLabel, setProfileAutoSaveLabel] = useState('');

  const getProfileSettingsCache = (): Record<string, any> => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('estimateace_profile_settings');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };

  const setProfileSettingsCache = (settings: Record<string, any>) => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('estimateace_profile_settings', JSON.stringify({
      ...getProfileSettingsCache(),
      ...settings,
    }));
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

  // Crew visibility restrictions (set when logged in as crew)
  const canSeePricing = !currentCrew || currentCrew.canSeePricing !== false;
  const canSeeFinancials = !currentCrew || currentCrew.canSeeEstimatesAndFinancials !== false;

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
      if (saved && ['en', 'es', 'fr'].includes(saved)) return saved;
    }
    return ((profile as any).language || 'en');
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
    breakdown = estimateBreakdownSettings
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
  const [translateFrom, setTranslateFrom] = useState<'en' | 'es' | 'fr' | 'de' | 'pt' | 'it'>('en');
  const [translateTo, setTranslateTo] = useState<'en' | 'es' | 'fr' | 'de' | 'pt' | 'it'>('es');
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

  // Photo / video media picker + device-style in-app camera (fixed chrome)
  const [isPhotoPickerOpen, setIsPhotoPickerOpen] = useState(false);
  const [isDeviceCameraOpen, setIsDeviceCameraOpen] = useState(false);
  const [deviceCameraMode, setDeviceCameraMode] = useState<DeviceCameraMode>('photo');

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
    if (!user?.id || !supabase) return null;
    const { data } = await supabase
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${user.id}`)
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

  useEffect(() => {
    resolveMediaDisplayUrl(profile.logoUrl, getMediaUrl).then(setLogoDisplayUrl);
  }, [profile.logoUrl, supabase]);

  useEffect(() => {
    resolveMediaDisplayUrl(profile.certificateUrl, getMediaUrl).then(setCertificateDisplayUrl);
  }, [profile.certificateUrl, supabase]);

  // Load language preference from localStorage
  useEffect(() => {
    const savedLang = localStorage.getItem('appLanguage');
    if (savedLang && ['en', 'es', 'fr'].includes(savedLang)) {
      setProfile(prev => {
        if (prev.language !== savedLang) {
          return { ...prev, language: savedLang };
        }
        return prev;
      });
    }
  }, []);

  // Restore client breakdown toggles from cache + server settings doc
  useEffect(() => {
    if (!user?.id || !supabase) return;
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
  }, [user?.id]);

  // Populate saved lists (for dashboard, lists, reports, etc.) as soon as we have a user
  useEffect(() => {
    if (user?.id && supabase) {
      refreshSavedList();
      refreshArchivesList();
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setAppointments([]);
      return;
    }
    try {
      const stored = localStorage.getItem(`estimateace_appointments_${user.id}`);
      const parsed = stored ? JSON.parse(stored) : [];
      setAppointments(parsed);
    } catch {
      setAppointments([]);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || appointments.length === 0) return;
    void syncAppointmentsToServer(appointments, profile);
  }, [user?.id, appointments.length, profile.appointmentReminderEnabled, profile.email, profile.phone]);

  useEffect(() => {
    if (!user?.id || !profile.appointmentReminderEnabled || !supabase) return;

    const checkMorningReminder = async () => {
      const timeZone = 'America/New_York';
      const now = new Date();
      const hour = Number(now.toLocaleString('en-US', { timeZone, hour: 'numeric', hour12: false }));
      if (hour !== 8) return;

      const todayKey = now.toLocaleDateString('en-CA', { timeZone });
      const lastLocal = localStorage.getItem(`estimateace_last_reminder_${user.id}`);
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
          localStorage.setItem(`estimateace_last_reminder_${user.id}`, todayKey);
        }
      } catch {
        // Reminder will be retried on next interval or by server cron
      }
    };

    void checkMorningReminder();
    const interval = window.setInterval(checkMorningReminder, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [user?.id, profile.appointmentReminderEnabled, appointments.length, supabase]);

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
          msg = 'Email not confirmed yet. Check your inbox for the confirmation link, or sign up again.';
        } else if (code === 'invalid_credentials') {
          msg = 'Invalid email or password. Click Sign Up to create a new account, or Forgot your password? to reset.';
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

  const signup = async () => {
    setLoginError('');
    if (!supabase) {
      const msg = getSupabaseConfigHelpMessage();
      setLoginError(msg);
      showMessage(msg);
      return;
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      const msg = 'Enter an email and password to sign up.';
      setLoginError(msg);
      showMessage(msg);
      return;
    }
    const { data, error } = await supabase.auth.signUp({ email: trimmedEmail, password });
    if (error) {
      setLoginError(error.message);
      showMessage(error.message);
      return;
    }
    if (data.session?.user) {
      setUser(data.session.user);
      setShowLogin(false);
      showMessage('Account created — you are logged in!');
      return;
    }
    if (data.user && !data.session) {
      const msg = 'Account created! Check your email for a confirmation link, then log in.';
      setLoginError(msg);
      showMessage(msg);
    } else {
      showMessage('Account created! You can log in now.');
    }
  };

  const handleCrewLogin = async () => {
    if (!supabase) return showMessage('Supabase not configured');
    const email = crewLoginEmail.trim();
    if (!email) return showMessage('Enter crew email');

    // DEMO: Match by email only. Passwords are no longer stored or required (security fix).
    // In production: Replace with real Supabase Auth user accounts for crew members + proper RLS.
    const { data: docs, error } = await supabase
      .from('estimates')
      .select('id, user_id, profile')
      .limit(100);

    if (error || !docs) return showMessage('Error looking up crew account');

    let ownerUserId: string | null = null;
    let matchedCrew: any = null;

    for (const doc of docs) {
      const crewList = doc.profile?.teammates || [];
      const found = crewList.find((c: any) => c.email === email);
      if (found) {
        ownerUserId = doc.user_id;
        matchedCrew = found;
        break;
      }
    }

    if (!ownerUserId || !matchedCrew) {
      return showMessage('Invalid crew email. Ask the account owner to add you.');
    }

    // Set as "logged in" using the owner's id for data access
    setUser({ id: ownerUserId, email: email } as any);
    setCurrentCrew(matchedCrew);

    // Load the profile from the first matching doc (or latest)
    const ownerDoc = docs.find((d: any) => d.user_id === ownerUserId);
    if (ownerDoc?.profile) {
      const preferredLang = getPreferredLanguage();
      const displaySettings = getGlobalDisplaySettings(profile);
      const {
        showMaterialBreakdownOnEstimate: _sm,
        showLaborBreakdownOnEstimate: _sl,
        showCostBreakdownOnEstimate: _sc,
        showPriceBreakdownByLine: _sp,
        showDiscountOnEstimate: _sd,
        ...ownerProfileWithoutBreakdown
      } = ownerDoc.profile;
      setProfile({
        ...profile,
        ...ownerProfileWithoutBreakdown,
        crewSubscriptionActive: ownerDoc.profile.crewSubscriptionActive ?? false,
        chargeCCFee: ownerDoc.profile.chargeCCFee ?? false,
        ccFeePercentage: ownerDoc.profile.ccFeePercentage ?? 3,
        autoSaveEnabled: ownerDoc.profile.autoSaveEnabled ?? true,
        ...displaySettings,
        appointmentReminderEnabled: ownerDoc.profile.appointmentReminderEnabled ?? false,
        showDepositOnApproval: ownerDoc.profile.showDepositOnApproval !== false,
        thirdPartyEscrowEnabled: ownerDoc.profile.thirdPartyEscrowEnabled ?? false,
        escrowMinimumAmount: ownerDoc.profile.escrowMinimumAmount ?? profile.escrowMinimumAmount ?? 10000,
        depositPercentage: ownerDoc.profile.depositPercentage ?? profile.depositPercentage ?? 10,
        paymentSettings: mergePaymentSettings(ownerDoc.profile.paymentSettings),
        language: preferredLang,
        teammates: (ownerDoc.profile.teammates || []).map((t: any) => ({
          ...t,
          canSeePricing: t.canSeePricing ?? false,
          canSeeEstimatesAndFinancials: t.canSeeEstimatesAndFinancials ?? false,
        })),
      });
    }

    // Refresh lists using the owner id (the setUser will help trigger effects)
    setTimeout(() => {
      refreshSavedList();
    }, 200);

    showMessage(`✅ Logged in as crew/sub-contractor: ${email}`);
    setCrewLoginEmail('');
    setCrewLoginPassword('');

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

  const logout = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setCurrentCrew(null);
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

  // Crew / Sub-contractor forgot password (simulated - finds the owner document and resets the password in it)
  const requestCrewPasswordReset = async () => {
    if (!supabase || !crewForgotEmail.trim()) {
      showMessage('Please enter the crew email');
      return;
    }
    const email = crewForgotEmail.trim();

    try {
      const { data: docs, error } = await supabase
        .from('estimates')
        .select('id, user_id, profile')
        .limit(100);

      if (error || !docs) {
        showMessage('Could not look up crew account');
        return;
      }

      let foundDoc: any = null;
      let crewIndex = -1;

      for (const doc of docs) {
        const crewList = doc.profile?.teammates || [];
        const idx = crewList.findIndex((c: any) => c.email === email);
        if (idx !== -1) {
          foundDoc = doc;
          crewIndex = idx;
          break;
        }
      }

      if (!foundDoc || crewIndex === -1) {
        showMessage('No crew account found with that email');
        return;
      }

      // Crew password reset disabled for security.
      // In production: Invite crew as real Supabase users (they set their own password via magic link/email).
      showMessage('Password reset is not available for crew accounts. Contact your account administrator.');
      setCrewForgotEmail('');
      setShowCrewForgot(false);
    } catch (e: any) {
      showMessage('Failed to reset crew password. Please try again.');
    }
  };

  const saveToDB = async (options?: {
    profile?: typeof profile;
    breakdown?: typeof estimateBreakdownSettings;
  }) => {
    if (!user || !supabase) return;
    const profileToSave = options?.profile ?? profile;
    const breakdownToSave = options?.breakdown ?? estimateBreakdownSettings;
    const data = {
      user_id: user.id,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile: getDocumentProfileSnapshot(profileToSave, breakdownToSave),
      documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod, photoUrls, videoUrls, receiptUrls, receiptDetails,
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
      setLastSaved(new Date().toLocaleTimeString());
      refreshSavedList();
    }
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video' | 'receipt') => {
    if (!files || !user || !supabase) return 0;
    const newUrls: string[] = [];
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const fileExt = file.name.split('.').pop() || (type === 'video' ? 'mp4' : 'jpg');
      const filePath = `${user.id}/${type}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`;
      const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
      if (!error) {
        // Store the permanent storage path (not the temporary signed URL)
        newUrls.push(filePath);
      } else {
        console.error('Media upload failed:', error);
        showMessage(`Failed to upload ${type}. Check your connection and try again.`);
      }
    }
    if (type === 'photo') setPhotoUrls(prev => [...prev, ...newUrls]);
    else if (type === 'video') setVideoUrls(prev => [...prev, ...newUrls]);
    else if (type === 'receipt') {
      setReceiptUrls(prev => [...prev, ...newUrls]);
      if (newUrls.length > 0) {
        // For receipt extract, we still need a display URL right away
        const firstUrl = await getMediaUrl(newUrls[0]);
        if (firstUrl) setCurrentReceiptUrl(firstUrl);
      }
      setTempReceiptData({ date: new Date().toISOString().split('T')[0], vendor: '', amount: 0, notes: '' });
      setIsReceiptExtractModalOpen(true);
    }
    if (newUrls.length > 0) {
      await saveToDB();
    }
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
    const filePath = `${user.id}/certificate/${Date.now()}-${file.name}`;
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
    const filePath = `${user.id}/logo/${Date.now()}-${file.name}`;
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
    const saved = await handleMediaUpload(files, 'photo');
    if (saved > 0) {
      showMessage(`${saved} photo${saved === 1 ? '' : 's'} added to this estimate.`);
    }
    if (photoGalleryInputRef.current) photoGalleryInputRef.current.value = '';
  };

  const handleVideoGalleryChange = async (files: FileList | null) => {
    const saved = await handleMediaUpload(files, 'video');
    if (saved > 0) {
      showMessage(`${saved} video${saved === 1 ? '' : 's'} added to this estimate.`);
    }
    if (videoGalleryInputRef.current) videoGalleryInputRef.current.value = '';
  };

  const handleDeviceCameraPhoto = async (file: File) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    await handleMediaUpload(dt.files, 'photo');
  };

  const handleDeviceCameraVideo = async (file: File) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    await handleMediaUpload(dt.files, 'video');
  };

  const handleDeviceCameraClose = (count: number) => {
    setIsDeviceCameraOpen(false);
    if (count > 0) {
      showMessage(
        `${count} ${deviceCameraMode === 'video' ? 'video' : 'photo'}${count === 1 ? '' : 's'} saved to this estimate.`
      );
    }
  };

  const refreshSavedList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('estimates').select('*').eq('user_id', user.id).order('updated_at', { ascending: false });
    setSavedEstimatesList(data || []);
  };

  const refreshArchivesList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('archive-est').select('*').eq('user_id', user.id).order('archived_at', { ascending: false });
    setArchivesList(data || []);
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
    setVideoUrls(est.videoUrls || []);
    setReceiptUrls(est.receiptUrls || []);
    setReceiptDetails(est.receiptDetails || []);
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
        .eq('user_id', user.id)
        .neq('id', `SETTINGS-${user.id}`)
        .order('updated_at', { ascending: false })
        .limit(1);
      const loaded = data?.[0]?.profile || null;
      const cached = getProfileSettingsCache();
      const cachedCompany = (cached.companyProfile || {}) as Record<string, any>;
      const preferredLang = getPreferredLanguage();

      // Prefer: SETTINGS → local company cache → latest estimate → current state
      const s = serverProfile || {};
      const l = loaded || {};

      setProfile(prev => {
        const displaySettings = getGlobalDisplaySettings(prev, serverProfile);
        const {
          showMaterialBreakdownOnEstimate: _sm,
          showLaborBreakdownOnEstimate: _sl,
          showCostBreakdownOnEstimate: _sc,
          showPriceBreakdownByLine: _sp,
          showDiscountOnEstimate: _sd,
          ...loadedWithoutBreakdown
        } = l as any;

        return {
          ...prev,
          // non-company fields may still come from latest estimate
          ...loadedWithoutBreakdown,
          // Company identity: never overwrite filled values with empty ones
          name: pickFilled(s.name, cachedCompany.name, l.name, prev.name),
          company: pickFilled(s.company, cachedCompany.company, l.company, prev.company),
          slogan: pickFilled(s.slogan, cachedCompany.slogan, l.slogan, prev.slogan),
          address: pickFilled(s.address, cachedCompany.address, l.address, prev.address),
          phone: pickFilled(s.phone, cachedCompany.phone, l.phone, prev.phone),
          email: pickFilled(s.email, cachedCompany.email, l.email, prev.email),
          city: pickFilled(s.city, cachedCompany.city, l.city, prev.city),
          state: pickFilled(s.state, cachedCompany.state, l.state, prev.state),
          zipCode: pickFilled(s.zipCode, cachedCompany.zipCode, l.zipCode, prev.zipCode),
          disclosure: pickFilled(s.disclosure, cachedCompany.disclosure, l.disclosure, prev.disclosure),
          logoUrl: pickFilled(s.logoUrl, cachedCompany.logoUrl, l.logoUrl, prev.logoUrl),
          certificateUrl: pickFilled(s.certificateUrl, cachedCompany.certificateUrl, l.certificateUrl, prev.certificateUrl),
          logoSize: pickFilled(s.logoSize, cachedCompany.logoSize, l.logoSize, prev.logoSize, 'medium'),
          crewSubscriptionActive: s.crewSubscriptionActive ?? l.crewSubscriptionActive ?? prev.crewSubscriptionActive ?? false,
          chargeCCFee: s.chargeCCFee ?? l.chargeCCFee ?? prev.chargeCCFee ?? false,
          ccFeePercentage: s.ccFeePercentage ?? l.ccFeePercentage ?? prev.ccFeePercentage ?? 3,
          autoSaveEnabled: 'autoSaveEnabled' in (s as any)
            ? (s as any).autoSaveEnabled !== false
            : ('autoSaveEnabled' in l
              ? l.autoSaveEnabled !== false
              : (cached.autoSaveEnabled ?? prev.autoSaveEnabled ?? true)),
          taxesEnabled: 'taxesEnabled' in cached
            ? cached.taxesEnabled !== false
            : (serverProfile && 'taxesEnabled' in serverProfile
              ? serverProfile.taxesEnabled !== false
              : ('taxesEnabled' in l
                ? l.taxesEnabled !== false
                : prev.taxesEnabled !== false)),
          ...displaySettings,
          appointmentReminderEnabled: 'appointmentReminderEnabled' in (s as any)
            ? !!(s as any).appointmentReminderEnabled
            : ('appointmentReminderEnabled' in l
              ? !!l.appointmentReminderEnabled
              : (cached.appointmentReminderEnabled ?? prev.appointmentReminderEnabled ?? false)),
          showDepositOnApproval: 'showDepositOnApproval' in (s as any)
            ? (s as any).showDepositOnApproval !== false
            : ('showDepositOnApproval' in l
              ? l.showDepositOnApproval !== false
              : (cached.showDepositOnApproval ?? prev.showDepositOnApproval ?? true)),
          thirdPartyEscrowEnabled: 'thirdPartyEscrowEnabled' in (s as any)
            ? !!(s as any).thirdPartyEscrowEnabled
            : ('thirdPartyEscrowEnabled' in l
              ? !!l.thirdPartyEscrowEnabled
              : (cached.thirdPartyEscrowEnabled ?? prev.thirdPartyEscrowEnabled ?? false)),
          escrowMinimumAmount:
            'escrowMinimumAmount' in cached
              ? Math.max(0, Number(cached.escrowMinimumAmount) || 0)
              : (serverProfile && 'escrowMinimumAmount' in serverProfile
                ? Math.max(0, Number(serverProfile.escrowMinimumAmount) || 0)
                : ('escrowMinimumAmount' in l
                  ? Math.max(0, Number(l.escrowMinimumAmount) || 0)
                  : Math.max(0, Number(prev.escrowMinimumAmount) || 0))),
          depositPercentage: s.depositPercentage ?? l.depositPercentage ?? cached.depositPercentage ?? prev.depositPercentage ?? 10,
          paymentSettings: mergePaymentSettings({
            ...(prev.paymentSettings || {}),
            ...(l.paymentSettings || {}),
            ...(serverProfile?.paymentSettings || {}),
            venmo: {
              ...mergePaymentSettings(prev.paymentSettings).venmo,
              ...mergePaymentSettings(l.paymentSettings).venmo,
              ...mergePaymentSettings(serverProfile?.paymentSettings).venmo,
              handle: pickFilled(
                mergePaymentSettings(serverProfile?.paymentSettings).venmo?.handle,
                mergePaymentSettings(l.paymentSettings).venmo?.handle,
                mergePaymentSettings(prev.paymentSettings).venmo?.handle
              ),
            },
          }),
          language: preferredLang,
          teammates: ((s.teammates || l.teammates || prev.teammates || []) as any[]).map((t: any) => ({
            ...t,
            canSeePricing: t.canSeePricing ?? false,
            canSeeEstimatesAndFinancials: t.canSeeEstimatesAndFinancials ?? false,
          })),
        };
      });
      return serverProfile || loaded;
    } finally {
      // Allow auto-save only after hydrate settles
      window.setTimeout(() => {
        profileHydratingRef.current = false;
      }, 400);
    }
  };

  const newEstimate = async () => {
    setJobName(''); setAddress(''); setCity(''); setState(''); setZipCode('');
    setPhones(['']); setEmails(['']); setTerms('');
    setPhotoUrls([]); setVideoUrls([]); setReceiptUrls([]); setReceiptDetails([]);
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
    }
  };

  const convertToInvoice = () => {
    setDocumentType('invoice');
    if (invoiceNumber.startsWith('EST-')) setInvoiceNumber(invoiceNumber.replace('EST-', 'INV-'));
    setView('sendPreview');
  };

  // Build a clean archive payload using only columns that exist in the "archive-est" table.
  // Sanitize values (undefined -> null, ensure correct array/boolean/number shapes) to avoid
  // obscure server-side insert/upsert errors that sometimes surface as empty {} in the client.
  const prepareArchiveData = (estRow: any) => {
    if (!estRow) return null;

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

    return {
      id: estRow.id,
      user_id: estRow.user_id,
      documentType: estRow.documentType || 'invoice',
      jobName: estRow.jobName ?? null,
      address: estRow.address ?? null,
      city: estRow.city ?? null,
      state: estRow.state ?? null,
      zipCode: estRow.zipCode ?? null,
      phones: toArray(estRow.phones),
      emails: toArray(estRow.emails),
      date: estRow.date ?? null,
      invoiceNumber: estRow.invoiceNumber,
      items: Array.isArray(estRow.items) ? estRow.items : [],
      terms: estRow.terms ?? null,
      laborHours: toNum(estRow.laborHours),
      laborRate: toNum(estRow.laborRate),
      laborFixedAmount: toNum(estRow.laborFixedAmount),
      useHourlyLabor: toBool(estRow.useHourlyLabor, true),
      laborAmount: toNum(estRow.laborAmount),
      taxRate: toNum(estRow.taxRate),
      taxAmount: toNum(estRow.taxAmount),
      isTaxExempt: toBool(estRow.isTaxExempt, false),
      taxLabor: toBool(estRow.taxLabor, true),
      photoUrls: toArray(estRow.photoUrls),
      videoUrls: toArray(estRow.videoUrls),
      receiptUrls: toArray(estRow.receiptUrls),
      receiptDetails: Array.isArray(estRow.receiptDetails) ? estRow.receiptDetails : [],
      dueDate: estRow.dueDate ?? null,
      paymentStatus: estRow.paymentStatus ?? 'pending',
      amountPaid: toNum(estRow.amountPaid),
      paymentMethod: estRow.paymentMethod ?? null,
      profile: (estRow.profile && typeof estRow.profile === 'object') ? estRow.profile : {},
      updated_at: estRow.updated_at ?? new Date().toISOString(),
      archived_at: new Date().toISOString(),
    };
  };

  const markAsPaidCash = async () => {
    if (!confirm('Mark this invoice as Paid (Cash) and close it out to the archives?')) return;
    if (!user || !supabase) return;

    const id = invoiceNumber;

    try {
      // Explicitly save the paid/cash status (avoids stale state from setPayment* + immediate await saveToDB)
      const paidData = {
        user_id: user.id,
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
        .eq('user_id', user.id)
        .single();
      if (fetchErr || !est) {
        console.error('Fetch for archive failed:', fetchErr);
        showMessage('✅ Invoice marked as Paid (Cash), but could not load for archiving.');
        setView('invoicesList');
        await refreshSavedList();
        return;
      }

      // Archive using clean column list.
      // To avoid any upsert/onConflict quirks + duplicate key issues, first remove any prior
      // archive copy of this id, then INSERT. This mirrors the original "close out" move intent.
      const archiveData = prepareArchiveData(est);
      if (!archiveData) {
        showMessage('✅ Invoice marked as Paid (Cash), but archiving failed (no data).');
        return;
      }

      // Pre-clear (best-effort) so we never hit PK violation on the subsequent insert.
      await supabase.from('archive-est').delete().eq('id', id).eq('user_id', user.id);

      const result = await supabase.from('archive-est').insert(archiveData);
      const { data: inserted, error, status, statusText } = result;

      if (error) {
        // Log EVERYTHING we can get — the previous {} was unhelpful.
        console.error('Archive insert error (FULL RESULT):', {
          error,
          status,
          statusText,
          inserted,
          archiveDataKeys: Object.keys(archiveData),
          hasUserId: !!archiveData.user_id,
          id: archiveData.id,
        });
        // Try to surface something useful even when the error object itself looks empty.
        const errDetail =
          (error as any)?.message ||
          (error as any)?.error ||
          (error as any)?.hint ||
          (error as any)?.code ||
          JSON.stringify(error) ||
          statusText ||
          'unknown error (see console for status)';
        console.error('Archive insert raw error object:', error);
        showMessage(`✅ Invoice marked as Paid (Cash), but archiving failed: ${errDetail} (status ${status ?? '??'})`);
        await refreshSavedList();
        return;
      }

      await supabase.from('estimates').delete().eq('id', id);

      showMessage('✅ Invoice marked as Paid (Cash) and closed to archives');
      setView('invoicesList');
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
    if (!user?.id || !supabase) return;
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
    await supabase.from('estimates').upsert({
      id: `SETTINGS-${user.id}`,
      user_id: user.id,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      profile: mergedProfile,
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
      localStorage.setItem(`estimateace_appointments_${user.id}`, JSON.stringify(nextAppointments));
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
      .eq('user_id', user.id)
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
    await supabase.from('estimates').delete().eq('id', id);
    setSelectedIds(prev => prev.filter(sid => sid !== id));
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const archiveEstimate = async (id: string) => {
    if (!confirm('Archive this document?')) return;
    if (!user || !supabase) return;

    try {
      const { data: est, error: fetchErr } = await supabase.from('estimates').select('*').eq('id', id).single();
      if (fetchErr || !est) {
        console.error('Archive fetch error:', fetchErr);
        return;
      }

      const archiveData = prepareArchiveData(est);
      if (!archiveData) return;

      // Pre-clear then insert (consistent with markAsPaidCash; avoids onConflict/upsert quirks)
      await supabase.from('archive-est').delete().eq('id', id).eq('user_id', user?.id || '');
      const result = await supabase.from('archive-est').insert(archiveData);
      const { error, status, statusText } = result;
      if (error) {
        console.error('Archive insert error (FULL):', { error, status, statusText });
        return;
      }

      await supabase.from('estimates').delete().eq('id', id);
      setSelectedIds(prev => prev.filter(sid => sid !== id));
      showMessage('Document archived successfully');
      refreshSavedList();
    } catch (e: any) {
      console.error('Unexpected error archiving', id, e);
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
    if (!user || !supabase) return;

    for (const id of selectedIds) {
      const { data: est, error: fetchErr } = await supabase.from('estimates').select('*').eq('id', id).single();
      if (fetchErr || !est) {
        console.error('Bulk archive fetch error for', id, fetchErr);
        continue;
      }
      const archiveData = prepareArchiveData(est);
      if (archiveData) {
        // Pre-clear then insert (consistent behavior)
        await supabase.from('archive-est').delete().eq('id', id).eq('user_id', user?.id || '');
        const result = await supabase.from('archive-est').insert(archiveData);
        const { error, status, statusText } = result;
        if (error) {
          console.error('Bulk archive insert error for', id, { error, status, statusText });
        } else {
          await supabase.from('estimates').delete().eq('id', id);
        }
      }
    }
    showMessage(`${selectedIds.length} documents archived`);
    setSelectedIds([]);
    refreshSavedList();
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
      const { data: docs } = await supabase.from('estimates').select('*').eq('user_id', user.id);
      (docs || []).forEach(doc => {
        if ((exportOptions.estimates && (doc.documentType === 'estimate' || doc.invoiceNumber?.startsWith('EST'))) ||
            (exportOptions.invoices && (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')))) {
          const total = doc.items ? doc.items.reduce((sum: number, item: any) => sum + (item.total || 0), 0) : 0;
          csv += `"${doc.documentType || 'estimate'}","${doc.invoiceNumber || ''}","${doc.jobName || ''}","${doc.date || ''}","${doc.address || ''}","${doc.city || ''}","${doc.zipCode || ''}",${total},"${(doc.photoUrls || []).join('; ')}","${(doc.videoUrls || []).join('; ')}"\n`;
        }
      });
    }

    if (exportOptions.archives) {
      const { data: archives } = await supabase.from('archive-est').select('*').eq('user_id', user.id);
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
  }, [jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod, view, receiptDetails, isTaxExempt, taxLabor, appliedDiscountDescription, appliedDiscountValue, appliedDiscountType]);

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
    if (view === 'dashboard' || view === 'estimatesList' || view === 'invoicesList' || view === 'editor') refreshSavedList();
    if (view === 'archivesView' || view === 'editor') refreshArchivesList();
  }, [view]);

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

  const isVenmoPaymentReady = () => {
    const venmo = getVenmoSettings();
    return !!venmo?.enabled && hasVenmoHandle(venmo.handle);
  };

  const startVenmoPayment = (amount: number, label: string) => {
    const venmo = getVenmoSettings();
    const handle = cleanVenmoHandle(venmo?.handle || '');
    if (!handle) {
      showMessage('Add your Venmo username in Profile → Payments.');
      return false;
    }

    const note = `${profile.company || 'EstimateAce'} ${invoiceNumber} ${label}`;
    const opened = openVenmoPaymentPage(handle, amount, note);
    if (!opened) {
      showMessage('Could not open Venmo. Check the username in Profile → Payments.');
      return false;
    }

    showMessage(`Opening Venmo to pay $${amount.toFixed(2)}. Complete payment in the Venmo app, then your contractor will confirm receipt.`);
    return true;
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
        onClick={() => startVenmoPayment(amount, label)}
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
              @{handle}
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

    closePaymentModal();
    const meta = getPaymentMethodMeta(selectedPaymentMethod);
    showMessage(
      `${meta.label} is not connected for automatic checkout. Use Venmo or pay ${profile.company || 'the contractor'} directly.`
    );
  };

  const updateVenmoUsername = (value: string) => {
    const nextProfile = {
      ...profile,
      paymentSettings: {
        ...mergePaymentSettings(profile.paymentSettings),
        venmo: {
          ...mergePaymentSettings(profile.paymentSettings).venmo,
          enabled: mergePaymentSettings(profile.paymentSettings).venmo?.enabled ?? true,
          handle: value,
        },
      },
    };
    setProfile(nextProfile);
    void saveProfileSettings(nextProfile);
  };

  const renderPaymentMethodRow = (method: string, settings: { enabled?: boolean; connected?: boolean; handle?: string }) => {
    const meta = getPaymentMethodMeta(method);

    if (method === 'venmo') {
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
          <div className="mt-4 w-full min-w-0 sm:pl-12">
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('venmoUsername')}</label>
            <div className="flex items-center gap-2 w-full min-w-0 max-w-full">
              <span className="text-lg text-gray-500 shrink-0">@</span>
              <Input
                value={settings.handle || ''}
                onChange={(e) => {
                  const handle = e.target.value;
                  setProfile((prev) => ({
                    ...prev,
                    paymentSettings: {
                      ...mergePaymentSettings(prev.paymentSettings),
                      venmo: {
                        ...mergePaymentSettings(prev.paymentSettings).venmo,
                        handle,
                      },
                    },
                  }));
                }}
                onBlur={(e) => updateVenmoUsername(e.target.value)}
                placeholder={t('venmoUsernamePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 w-full max-w-full"
              />
            </div>
            <p className="text-xs text-gray-500 mt-2 break-words">{t('venmoUsernameHelp')}</p>
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
          {method !== 'venmo' && (
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
    if (method === 'venmo') return;

    const meta = getPaymentMethodMeta(method);
    const providerUrls: { [key: string]: string } = {
      stripe: 'https://dashboard.stripe.com/connect',
      echeck: 'https://dashboard.stripe.com/connect',
      paypal: 'https://www.paypal.com/businessmanage/credentials',
      zelle: 'https://www.zellepay.com/',
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
  const isEstimateDoc = (est: any) =>
    est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST');

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
  }, [savedEstimatesList, estimateListSearch]);

  const estimatesCount = savedEstimatesList.filter(isEstimateDoc).length;

  const outstandingInvoices = savedEstimatesList.filter(est => 
    (est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')) && 
    est.paymentStatus === 'pending'
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

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <ToastContainer />
        <Card className="w-full max-w-md p-8">
          <div>
            <h1 className="text-4xl font-bold text-center text-[#1e293b]">EstimateAce</h1>
          </div>

          {!showMainForgot ? (
            <>
              <Input placeholder="Email" value={email} onChange={e => { setEmail(e.target.value); setLoginError(''); }} className="mb-3" autoComplete="email" />
              <Input type="password" placeholder="Password" value={password} onChange={e => { setPassword(e.target.value); setLoginError(''); }} className="mb-4" autoComplete="current-password" onKeyDown={e => { if (e.key === 'Enter') login(); }} />
              {loginError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {loginError}
                </div>
              )}
              <div className="flex gap-3 mb-2">
                <Button onClick={login} className="flex-1" disabled={loginLoading}>{loginLoading ? 'Logging in...' : t('loginMain')}</Button>
                <Button onClick={signup} variant="outline" className="flex-1" disabled={loginLoading}>{t('signUp')}</Button>
              </div>
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
              <p className="text-[10px] text-gray-400 mt-4 leading-relaxed">
                Console errors about autofill/chrome-extension are from a browser add-on, not this app. Use Sign Up if you have not created an account on localhost yet.
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

          {/* Crew / Sub-contractor separate login */}
          <div className="mt-6 pt-4 border-t">
            <p className="text-sm font-medium text-center mb-3 text-gray-600">Crew / Sub-contractor Login</p>

            {!showCrewForgot ? (
              <>
                <Input 
                  placeholder="Your email (username)" 
                  value={crewLoginEmail} 
                  onChange={e => setCrewLoginEmail(e.target.value)} 
                  className="mb-2" 
                />
                {/* Password input removed. Crew login now matches by email only (demo).
                    Production: Use real Supabase Auth for crew members (no plaintext passwords). */}
                <Button 
                  onClick={handleCrewLogin} 
                  variant="outline" 
                  className="w-full mb-2"
                >
                  {t('logInAsCrew')}
                </Button>
                <button 
                  onClick={() => setShowCrewForgot(true)} 
                  className="text-sm text-blue-600 hover:underline w-full text-left"
                >
                  Forgot password?
                </button>
                <p className="text-[10px] text-gray-500 mt-2 text-center">
                  {t('crewLoginNote')}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-gray-600 mb-3">Password reset is not needed. Crew accounts log in with email only.</p>
                <button 
                  onClick={() => { setShowCrewForgot(false); setCrewForgotEmail(''); }} 
                  className="text-sm text-gray-600 hover:underline w-full"
                >
                  Back to crew login
                </button>
              </>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // Two-Factor Authentication screen - DISABLED for production (was 100% simulated/fake)
  // Real 2FA should use Supabase Auth Phone, authenticator apps, or SMS provider.
  if (false && requires2FA) {  // permanently disabled
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
            Logged in as crew/sub-contractor: {currentCrew.email} (limited access)
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
                <h2 className="text-3xl font-semibold">All {t('invoices')}</h2>
                {savedEstimatesList.filter(est => est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')).length > 0 && (
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => {
                      const invIds = savedEstimatesList
                        .filter(est => est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV'))
                        .map(est => est.id);
                      setSelectedIds(selectedIds.length === invIds.length ? [] : invIds);
                    }}
                  >
                    {selectedIds.length > 0 ? 'Deselect All' : 'Select All'}
                  </Button>
                )}
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
                {savedEstimatesList.filter(est => est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')).map((est) => (
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
                      {est.paymentStatus === 'paid' && <span className="px-3 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full">{t('paid')}</span>}
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
                              onChange={e => setTranslateFrom(e.target.value as any)}
                              className="border rounded px-2 py-1 bg-white"
                            >
                              <option value="en">English</option>
                              <option value="es">Spanish</option>
                              <option value="fr">French</option>
                              <option value="de">German</option>
                              <option value="pt">Portuguese</option>
                              <option value="it">Italian</option>
                            </select>

                            <span className="text-gray-400">→</span>

                            <select
                              value={translateTo}
                              onChange={e => setTranslateTo(e.target.value as any)}
                              className="border rounded px-2 py-1 bg-white"
                            >
                              <option value="es">Spanish</option>
                              <option value="en">English</option>
                              <option value="fr">French</option>
                              <option value="de">German</option>
                              <option value="pt">Portuguese</option>
                              <option value="it">Italian</option>
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
                </div>
              ) : (
                <div className="flex flex-wrap gap-3 mb-8">
                  <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">{t('saveEstimate')}</Button>
                  <Button onClick={printDocument} className="bg-[#3b82f6]">{t('printPreview')}</Button>
                  <Button onClick={openSendPreview} className="bg-[#8b5cf6]">{t('sendEstimate')}</Button>
                  <Button onClick={convertToInvoice} className="bg-[#f59e0b]">{t('convertToInvoice')}</Button>
                </div>
              )}

              {/* Gallery pickers only — live camera uses DeviceCamera (fixed border + shutter) */}
              <input
                ref={photoGalleryInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => void handlePhotoGalleryChange(e.target.files)}
              />
              <input
                ref={videoGalleryInputRef}
                type="file"
                accept="video/*"
                multiple
                className="hidden"
                onChange={e => void handleVideoGalleryChange(e.target.files)}
              />

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">{t('photosSection')} ({photoUrls.length})</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Use your phone camera to capture job photos. Tap 📷 AI Quote on any photo to price a line item.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {photoDisplayUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button
                          type="button"
                          onClick={() => openGalleryPhotoQuote(url)}
                          className="absolute bottom-2 left-2 right-2 bg-violet-600 hover:bg-violet-700 text-white text-xs py-1.5 px-2 rounded-lg shadow-md sm:opacity-0 sm:group-hover:opacity-100 transition"
                        >
                          📷 AI Quote
                        </button>
                        <button 
                          onClick={() => removeMedia('photo', i)} 
                          className="absolute top-2 right-2 bg-red-600 hover:bg-red-700 text-white text-4xl w-10 h-10 flex items-center justify-center rounded-2xl shadow-xl"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {/* Opens picker: device camera or gallery */}
                    <button
                      type="button"
                      onClick={openPhotoPicker}
                      className="flex flex-col items-center justify-center h-40 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition w-full"
                    >
                      <div className="text-4xl mb-1">📷</div>
                      <div className="text-xs text-gray-500">{t('addPhoto')}</div>
                    </button>
                  </div>
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
                  <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="mb-4">
                    {t('scanReceipt')}
                  </Button>
                  <Button onClick={() => setIsLaborModalOpen(true)} className="mb-4 bg-[#14b8a6]">
                    {t('laborButton')}
                  </Button>
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
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Attached Photos</h3>
                    <div className="grid grid-cols-2 gap-6">
                      {photoDisplayUrls.map((url, i) => (
                        <img key={i} src={url} alt={`Photo ${i + 1}`} className="w-full border rounded-xl shadow-sm max-h-64 object-contain" />
                      ))}
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

              <div className="flex border-b mb-8">
                <button 
                  onClick={() => setProfileTab('info')}
                  className={`flex-1 py-4 text-center font-semibold ${profileTab === 'info' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  Company Info
                </button>
                <button 
                  onClick={() => setProfileTab('payments')}
                  className={`flex-1 py-4 text-center font-semibold ${profileTab === 'payments' ? 'border-b-4 border-[#10b981] text-[#10b981]' : 'text-gray-500'}`}
                >
                  💳 Payments
                </button>
              </div>

              {profileTab === 'info' && (
                <Card className="mb-8">
                  <CardContent className="p-8 space-y-8">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-gray-500">
                        Company info saves automatically as you type. It stays until you edit it.
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
                      <label className="block text-sm font-semibold mb-2">{t('languageLabel') || 'Language / Idioma / Langue'}</label>
                      <div className="flex gap-3">
                        {[
                          { code: 'en', label: 'English' },
                          { code: 'es', label: 'Español' },
                          { code: 'fr', label: 'Français' },
                        ].map((lang) => (
                          <button
                            key={lang.code}
                            onClick={() => {
                              setProfile(prev => ({ ...prev, language: lang.code }));
                              localStorage.setItem('appLanguage', lang.code);
                              saveToDB();
                            }}
                            className={`px-4 py-2 text-sm rounded-lg border ${
                              profile.language === lang.code 
                                ? 'bg-[#10b981] text-white border-[#10b981]' 
                                : 'bg-white hover:bg-gray-50 border-gray-300'
                            }`}
                          >
                            {lang.label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Changes the interface language for estimates and invoices.</p>
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
                      <h3 className="font-semibold mb-4">{t('crew')}</h3>
                      <p className="text-xs text-gray-500 -mt-2 mb-3">$20/month per additional account (set by Estimate Ace — charged when you add team/sub accounts).</p>
                      <div className="flex flex-col gap-2 mb-6">
                        <Input placeholder="crew@email.com" id="crew-email" className="flex-1" />
                        <Button onClick={() => {
                          const emailInput = document.getElementById('crew-email') as HTMLInputElement;
                          const email = emailInput.value.trim();
                          if (!email) return showMessage('Enter email for the additional account');

                          if (profile.crewSubscriptionActive) {
                            // Already subscribed, just add the account
                            const newCrew = { 
                              email, 
                              role: 'limited' as 'full' | 'limited', 
                              canSeePricing: false, 
                              canSeeEstimatesAndFinancials: false 
                            };
                            setProfile(prev => ({
                              ...prev,
                              teammates: [...(prev.teammates || []), newCrew]
                            }));
                            emailInput.value = '';
                            showMessage('✅ Additional account added! They can log in using just their email.');
                            setTimeout(() => saveToDB(), 100);
                          } else {
                            // Need to activate the monthly charge for extra accounts
                            setPendingCrewEmail(email);
                            setSelectedCrewPaymentMethod(null);
                            setIsCrewPayModalOpen(true);
                            emailInput.value = '';
                          }
                        }}>Add Account (charges $20/mo)</Button>
                      </div>
                      <div className="space-y-3">
                        {profile.teammates && profile.teammates.map((crew, index) => (
                          <div key={index} className="flex items-center justify-between border p-4 rounded-lg">
                            <div className="font-medium">{crew.email}</div>
                            <div className="flex items-center gap-6">
                              <div className="flex items-center gap-2">
                                <span className="text-sm">Full</span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input type="checkbox" checked={crew.role === 'full'} onChange={() => {
                                    const updated = [...profile.teammates];
                                    updated[index].role = updated[index].role === 'full' ? 'limited' : 'full';
                                    setProfile(prev => ({ ...prev, teammates: updated }));
                                    saveToDB();
                                  }} className="sr-only peer" />
                                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                                </label>
                                <span className="text-sm">Limited</span>
                              </div>

                              {/* Visibility permissions for this crew member (controlled by main account holder) */}
                              <div className="flex items-center gap-4 text-xs">
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={crew.canSeePricing ?? false}
                                    onChange={() => {
                                      const updated = [...profile.teammates];
                                      updated[index].canSeePricing = !updated[index].canSeePricing;
                                      setProfile(prev => ({ ...prev, teammates: updated }));
                                      saveToDB();
                                    }}
                                    className="w-3 h-3 accent-[#10b981]"
                                  />
                                  <span>See pricing</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={crew.canSeeEstimatesAndFinancials ?? false}
                                    onChange={() => {
                                      const updated = [...profile.teammates];
                                      updated[index].canSeeEstimatesAndFinancials = !updated[index].canSeeEstimatesAndFinancials;
                                      setProfile(prev => ({ ...prev, teammates: updated }));
                                      saveToDB();
                                    }}
                                    className="w-3 h-3 accent-[#10b981]"
                                  />
                                  <span>See estimates & financials</span>
                                </label>
                              </div>

                              <Button variant="destructive" size="sm" onClick={() => {
                                if (!confirm('Delete this crew/sub-contractor member?')) return;
                                const updated = profile.teammates.filter((_, i) => i !== index);
                                setProfile(prev => ({ ...prev, teammates: updated }));
                                saveToDB();
                              }}>Delete</Button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Subscription status and cancel option */}
                      <div className="mt-4 pt-4 border-t flex flex-col gap-3">
                        {profile.crewSubscriptionActive ? (
                          <>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-green-600 font-medium">✓ Crew subscription active — $20/month</span>
                              <Button 
                                variant="outline" 
                                size="sm" 
                                onClick={() => {
                                  if (!confirm('Cancel the $20/month Crew/Sub-contractors subscription?\n\nExisting members will remain but you will need to resubscribe to add new ones.')) return;
                                  setProfile(prev => ({ ...prev, crewSubscriptionActive: false }));
                                  showMessage('✅ Subscription canceled. $20/month billing stopped.');
                                  saveToDB();
                                }}
                              >
                                Cancel Subscription
                              </Button>
                            </div>
                            <p className="text-[10px] text-gray-500">Canceling stops future billing. You can resubscribe anytime by adding another crew member.</p>
                          </>
                        ) : (
                          profile.teammates && profile.teammates.length > 0 && (
                            <div className="text-sm text-amber-600">
                              Subscription inactive. Add a new crew member to reactivate at $20/month.
                            </div>
                          )
                        )}
                      </div>
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

          {view === 'archivesView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to {t('dashboard')}</Button>
              <h2 className="text-3xl font-semibold mb-6">{t('archivedDocuments')}</h2>
              <div className="space-y-4">
                {archivesList.map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div>
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • Archived: {new Date(est.archived_at).toLocaleDateString()}</div>
                    </div>
                    <div className="flex gap-3">
                      <Button size="sm" onClick={async () => { await loadSelectedEstimate(est); setView('editor'); }}>{t('open')}</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>{t('delete')}</Button>
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
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Attached Photos</h3>
                    <div className="grid grid-cols-2 gap-6">
                      {photoDisplayUrls.map((url, i) => (
                        <img key={i} src={url} alt={`Photo ${i + 1}`} className="w-full border rounded-xl shadow-sm max-h-64 object-contain" />
                      ))}
                    </div>
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
          <button onClick={() => setView('reportsView')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
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
                const meta = getPaymentMethodMeta(method);
                const venmoHandle = method === 'venmo' ? cleanVenmoHandle(settings.handle || '') : '';

                if (method === 'venmo') {
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        closePaymentModal();
                        startVenmoPayment(paymentAmount, paymentType);
                      }}
                      className="w-full flex items-center gap-4 p-4 border-2 rounded-2xl border-[#008cff] bg-blue-50 hover:bg-blue-100 transition-all"
                    >
                      <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                      <div className="flex-1 text-left">
                        <div className="font-semibold text-[#005fa3]">{meta.label}</div>
                        <div className="text-xs text-gray-600">Tap to open Venmo and pay @{venmoHandle}</div>
                      </div>
                      <span className="text-xs font-semibold text-[#008cff]">Open app →</span>
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
              disabled={!selectedPaymentMethod || selectedPaymentMethod === 'venmo'}
              className="flex-1 bg-[#10b981]"
            >
              {selectedPaymentMethod === 'venmo' ? 'Tap Venmo above' : 'Continue to Pay'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PAYMENT MODAL FOR ADDING EXTRA ACCOUNTS ($20/mo) */}
      <Dialog open={isCrewPayModalOpen} onOpenChange={setIsCrewPayModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>💳 Add Additional Account — $20/mo</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <div className="text-center mb-4">
              <p>Charge <strong>$20/month</strong> to add another user account.</p>
              <div className="mt-2">
                Adding account for: <span className="font-semibold">{pendingCrewEmail}</span>
              </div>
            </div>

            <div className="text-center mb-6">
              <div className="text-4xl font-bold text-[#10b981]">$20</div>
              <p className="text-xs text-gray-500">per month</p>
            </div>

            <div className="space-y-3">
              {Object.entries(mergePaymentSettings(profile.paymentSettings)).map(([method, settings]) => {
                if (!settings?.enabled) return null;
                if (method === 'venmo' && !hasVenmoHandle(settings.handle)) return null;
                const meta = getPaymentMethodMeta(method);
                const venmoHandle = method === 'venmo' ? cleanVenmoHandle(settings.handle || '') : '';
                return (
                  <button
                    key={method}
                    onClick={() => setSelectedCrewPaymentMethod(method)}
                    className={`w-full flex items-center gap-4 p-4 border-2 rounded-2xl hover:bg-gray-50 transition-all ${selectedCrewPaymentMethod === method ? 'border-[#10b981] bg-green-50' : 'border-gray-200'}`}
                  >
                    <span className="text-3xl flex-shrink-0">{meta.icon}</span>
                    <div className="flex-1 text-left">
                      <div className="font-semibold">{meta.label}</div>
                      <div className="text-xs text-gray-500">
                        {venmoHandle ? `@${venmoHandle}` : meta.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {Object.values(mergePaymentSettings(profile.paymentSettings)).every(s => !s?.enabled) && (
              <p className="text-xs text-red-500 mt-2 text-center">No payment methods enabled. Enable one in the Payments tab.</p>
            )}
          </div>
          <DialogFooter className="flex gap-3">
            <Button variant="outline" onClick={() => setIsCrewPayModalOpen(false)} className="flex-1">
              Cancel
            </Button>
            <Button 
              onClick={() => {
                if (!selectedCrewPaymentMethod) {
                  showMessage('Please select a payment method');
                  return;
                }
                const method = selectedCrewPaymentMethod;
                setIsCrewPayModalOpen(false);

                // Add the additional account now that "payment" succeeded
                const newCrew = { 
                  email: pendingCrewEmail, 
                  role: 'limited' as 'full' | 'limited', 
                  canSeePricing: false, 
                  canSeeEstimatesAndFinancials: false 
                };
                setProfile(prev => ({
                  ...prev,
                  teammates: [...(prev.teammates || []), newCrew],
                  crewSubscriptionActive: true
                }));

                showMessage(`✅ Extra account added for ${pendingCrewEmail}. $20/month subscription activated.`);

                // Persist
                setTimeout(() => saveToDB(), 150);

                // Clean up
                setPendingCrewEmail('');
                setSelectedCrewPaymentMethod(null);
              }}
              disabled={!selectedCrewPaymentMethod}
              className="flex-1 bg-[#10b981]"
            >
              Pay $20/mo &amp; Activate Account
            </Button>
          </DialogFooter>
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
