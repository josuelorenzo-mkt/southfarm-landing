// Lightweight i18n for SouthFarm.
//
// Translation keys are the ENGLISH SOURCE STRINGS used in main.dart, so a
// missing translation degrades gracefully to English. Interpolated strings
// use {n} slots that t() fills from its args list, in order.

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Preference key for the language choice. Values: [systemLanguagePref] or
/// one of [supportedLanguageCodes]. Device-scoped: survives logout.
const String appLanguagePrefKey = 'app_language';

/// Stored value meaning "follow the system language" (the recommended
/// default).
const String systemLanguagePref = 'system';

/// Languages the app ships with.
const List<String> supportedLanguageCodes = ['en', 'es', 'pt'];

/// Endonyms shown in the language picker (each always in its own language).
const Map<String, String> languageEndonyms = {
  'en': 'English',
  'es': 'Español',
  'pt': 'Português',
};

/// Global source of truth for the language choice. The root widget listens
/// and rebuilds the whole app when it changes.
final ValueNotifier<String> appLanguageNotifier =
    ValueNotifier<String>(systemLanguagePref);

/// Resolved language code: the explicit override if set, otherwise the
/// system locale clamped to a supported language (English when the system
/// language is not shipped).
String get activeLanguageCode {
  final override = appLanguageNotifier.value;
  if (override != systemLanguagePref &&
      supportedLanguageCodes.contains(override)) {
    return override;
  }
  return systemLanguageCode;
}

String get systemLanguageCode {
  final raw = Platform.localeName
      .replaceAll('_', '-')
      .split('-')
      .first
      .toLowerCase();
  return supportedLanguageCodes.contains(raw) ? raw : 'en';
}

bool get followingSystem => appLanguageNotifier.value == systemLanguagePref;

/// Human-readable label of the device's system locale, built from endonyms
/// plus region proper nouns (e.g. "es-AR" → "Español (Argentina)").
String systemLanguageLabel() {
  final parts = Platform.localeName.replaceAll('_', '-').split('-');
  const endonyms = {
    'es': 'Español',
    'en': 'English',
    'pt': 'Português',
    'fr': 'Français',
    'de': 'Deutsch',
    'it': 'Italiano',
    'zh': '中文',
    'ja': '日本語',
    'ko': '한국어',
    'ru': 'Русский',
    'hi': 'हिन्दी',
    'ar': 'العربية',
    'nl': 'Nederlands',
    'pl': 'Polski',
    'tr': 'Türkçe',
  };
  const regions = {
    'ar': 'Argentina',
    'mx': 'Mexico',
    'co': 'Colombia',
    'cl': 'Chile',
    'pe': 'Peru',
    'uy': 'Uruguay',
    'es': 'Spain',
    'us': 'United States',
    'gb': 'United Kingdom',
    'br': 'Brazil',
    'pt': 'Portugal',
  };
  final language = endonyms[parts[0].toLowerCase()] ?? parts[0].toUpperCase();
  final region = parts.length > 1
      ? regions[parts[1].toLowerCase()]
      : null;
  return region != null ? '$language ($region)' : language;
}

/// Loads the persisted language preference. Called once from main() before
/// runApp so the very first frame already uses the chosen language.
Future<void> loadAppLanguage() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    appLanguageNotifier.value =
        prefs.getString(appLanguagePrefKey) ?? systemLanguagePref;
  } catch (_) {
    appLanguageNotifier.value = systemLanguagePref;
  }
}

/// Persists and applies a language choice.
Future<void> setAppLanguage(String value) async {
  appLanguageNotifier.value = value;
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(appLanguagePrefKey, value);
  } catch (_) {}
}

/// Translates [key] (the English source text) into the active language.
/// Missing translations fall back to the key itself.
String t(String key, [List<Object?> args = const []]) {
  var text = _translations[activeLanguageCode]?[key] ?? key;
  for (final arg in args) {
    text = text.replaceFirst('{n}', '$arg');
  }
  return text;
}

const Map<String, Map<String, String>> _translations = {
  'es': {
    // Main screen / drawer
    'Accounts': 'Cuentas',
    'History': 'Historial',
    'Accessibility is disabled. Remote tasks cannot run.':
        'La accesibilidad está desactivada. Las tareas remotas no pueden ejecutarse.',
    'SouthFarm service is not running. Re-enable Accessibility to receive remote tasks.':
        'El servicio de SouthFarm no está corriendo. Reactivá la accesibilidad para recibir tareas remotas.',
    'Fix': 'Corregir',
    'Log out': 'Cerrar sesión',
    'Do you want to log out, {n}?': '¿Querés cerrar sesión, {n}?',
    'Cancel': 'Cancelar',
    'WORKSPACE': 'ESPACIO DE TRABAJO',
    'Workspace': 'Espacio de trabajo',
    'Role': 'Rol',
    'DEVICE': 'DISPOSITIVO',
    'Phone': 'Teléfono',
    'Model': 'Modelo',
    'App version': 'Versión de la app',
    'Accessibility': 'Accesibilidad',
    'Active': 'Activo',
    'Disabled': 'Desactivado',
    'PREFERENCES': 'PREFERENCIAS',
    'Language': 'Idioma',
    'System': 'Sistema',
    'Recommended': 'Recomendado',
    'SouthFarm user': 'Usuario de SouthFarm',
    'unknown': 'Desconocido',
    // Auth
    'Log In': 'Iniciar sesión',
    'Sign Up': 'Crear cuenta',
    'Email': 'Email',
    'Password': 'Contraseña',
    'Name': 'Nombre',
    'Please fill in all fields': 'Completá todos los campos',
    'Incorrect email or password': 'Email o contraseña incorrectos',
    'Error creating account. Already exists?':
        'Error al crear la cuenta. ¿Ya existe?',
    // Onboarding / splash
    'Welcome to SouthFarm': 'Bienvenido a SouthFarm',
    'Automate tasks on your phone.\nWarmups, posts, and more.':
        'Automatizá tareas en tu teléfono.\nWarmups, publicaciones y más.',
    'Enable Accessibility': 'Activar accesibilidad',
    'SouthFarm needs accessibility permission\nto simulate screen taps.':
        'SouthFarm necesita permiso de accesibilidad\npara simular toques en pantalla.',
    'Enable Overlay': 'Activar overlay',
    'You will see a protective layer when\nSouthFarm is working.':
        'Verás una capa protectora cuando\nSouthFarm esté trabajando.',
    'All set!': '¡Todo listo!',
    'Set up your tasks and get started.\nsouthfarm.tech':
        'Configurá tus tareas y empezá.\nsouthfarm.tech',
    'Mobile automation': 'Automatización móvil',
    'Enable': 'Activar',
    'Get Started': 'Empezar',
    'Tap the button and enable SouthFarm in Accessibility':
        'Tocá el botón y activá SouthFarm en Accesibilidad',
    'Tap the button and allow SouthFarm over other apps':
        'Tocá el botón y permití que SouthFarm se muestre sobre otras apps',
    // Device pairing / QR
    'Pair phone': 'Vincular celular',
    'This phone is not paired to your workspace yet.':
        'Este celular todavía no está vinculado a tu workspace.',
    'Scan QR': 'Escanear QR',
    'Generate a code from Device fleet on the web. You can enter the key manually or scan the temporary QR.':
        'Generá un código desde Device fleet en la web. Podés ingresar la llave manualmente o escanear el QR temporal.',
    'Enter the code and the temporary key':
        'Ingresá el código y la llave temporal',
    'Temporary code': 'Código temporal',
    'Access key': 'Llave de acceso',
    'Pairing…': 'Vinculando…',
    'Scan temporary QR': 'Escanear QR temporal',
    'Invalid or expired QR': 'QR inválido o vencido',
    'The code is invalid, expired or already used':
        'El código no es válido, venció o ya fue utilizado',
    'Point the camera at the pairing QR shown on the web':
        'Apuntá al QR de vinculación que muestra la web',
    'QR does not contain a SouthFarm pairing':
        'El QR no contiene una vinculación de SouthFarm',
    // Warmup
    'Start Warmup': 'Iniciar warmup',
    'Pause Warmup': 'Pausar warmup',
    'Resume Warmup': 'Reanudar warmup',
    'Stop Warmup': 'Detener warmup',
    'Warmup complete': 'Warmup completado',
    'Duration': 'Duración',
    'No sessions yet': 'Aún no hay sesiones',
    '{n} sessions': '{n} sesiones',
    'Scan': 'Escanear',
    'Scan accounts': 'Escanear cuentas',
    'Detected Instagram accounts': 'Cuentas de Instagram detectadas',
    'Detected TikTok accounts': 'Cuentas de TikTok detectadas',
    'Detected YouTube channels': 'Canales de YouTube detectados',
    'Clean accounts': 'Limpiar cuentas',
    'Choose the scanned platforms to remove from this phone. Scan history will be preserved.':
        'Elegí las plataformas escaneadas para quitar de este teléfono. El historial de escaneos se conserva.',
    'Select all': 'Seleccionar todo',
    'Clear selection': 'Quitar selección',
    'Clean selected': 'Limpiar seleccionadas',
    'Cleaning accounts…': 'Limpiando cuentas…',
    'Cleaned {n} scanned account records':
        'Se limpiaron {n} registros de cuentas escaneadas',
    'Could not clean scanned accounts':
        'No se pudieron limpiar las cuentas escaneadas',
    'Clean accounts failed: {n}': 'Error al limpiar cuentas: {n}',
    'Select account...': 'Seleccionar cuenta...',
    'Select an account first': 'Primero seleccioná una cuenta',
    'No accounts found': 'No se encontraron cuentas',
    'Session synced to backend': 'Sesión sincronizada con el backend',
    // Accounts screen
    'Instagram Account': 'Cuenta de Instagram',
    'TikTok Account': 'Cuenta de TikTok',
    'YouTube Channel': 'Canal de YouTube',
    // Metrics / history
    'Likes': 'Likes',
    'Saves': 'Guardados',
    'Videos': 'Videos',
    'Platform': 'Plataforma',
  },
  'pt': {
    // Main screen / drawer
    'Accounts': 'Contas',
    'History': 'Histórico',
    'Accessibility is disabled. Remote tasks cannot run.':
        'A acessibilidade está desativada. As tarefas remotas não podem ser executadas.',
    'SouthFarm service is not running. Re-enable Accessibility to receive remote tasks.':
        'O serviço do SouthFarm não está em execução. Reative a acessibilidade para receber tarefas remotas.',
    'Fix': 'Corrigir',
    'Log out': 'Sair',
    'Do you want to log out, {n}?': 'Deseja sair da conta, {n}?',
    'Cancel': 'Cancelar',
    'WORKSPACE': 'ESPAÇO DE TRABALHO',
    'Workspace': 'Espaço de trabalho',
    'Role': 'Função',
    'DEVICE': 'DISPOSITIVO',
    'Phone': 'Telefone',
    'Model': 'Modelo',
    'App version': 'Versão do app',
    'Accessibility': 'Acessibilidade',
    'Active': 'Ativo',
    'Disabled': 'Desativado',
    'PREFERENCES': 'PREFERÊNCIAS',
    'Language': 'Idioma',
    'System': 'Sistema',
    'Recommended': 'Recomendado',
    'SouthFarm user': 'Usuário do SouthFarm',
    'unknown': 'Desconhecido',
    // Auth
    'Log In': 'Entrar',
    'Sign Up': 'Criar conta',
    'Email': 'E-mail',
    'Password': 'Senha',
    'Name': 'Nome',
    'Please fill in all fields': 'Preencha todos os campos',
    'Incorrect email or password': 'E-mail ou senha incorretos',
    'Error creating account. Already exists?':
        'Erro ao criar a conta. Já existe?',
    // Onboarding / splash
    'Welcome to SouthFarm': 'Bem-vindo ao SouthFarm',
    'Automate tasks on your phone.\nWarmups, posts, and more.':
        'Automatize tarefas no seu telefone.\nWarmups, publicações e mais.',
    'Enable Accessibility': 'Ativar acessibilidade',
    'SouthFarm needs accessibility permission\nto simulate screen taps.':
        'O SouthFarm precisa de permissão de acessibilidade\npara simular toques na tela.',
    'Enable Overlay': 'Ativar sobreposição',
    'You will see a protective layer when\nSouthFarm is working.':
        'Você verá uma camada protetora quando\no SouthFarm estiver trabalhando.',
    'All set!': 'Tudo pronto!',
    'Set up your tasks and get started.\nsouthfarm.tech':
        'Configure suas tarefas e comece.\nsouthfarm.tech',
    'Mobile automation': 'Automação móvel',
    'Enable': 'Ativar',
    'Get Started': 'Começar',
    'Tap the button and enable SouthFarm in Accessibility':
        'Toque no botão e ative o SouthFarm em Acessibilidade',
    'Tap the button and allow SouthFarm over other apps':
        'Toque no botão e permita que o SouthFarm apareça sobre outros apps',
    // Device pairing / QR
    'Pair phone': 'Vincular telefone',
    'This phone is not paired to your workspace yet.':
        'Este telefone ainda não está vinculado ao seu workspace.',
    'Scan QR': 'Escanear QR',
    'Generate a code from Device fleet on the web. You can enter the key manually or scan the temporary QR.':
        'Gere um código em Device fleet na web. Você pode digitar a chave manualmente ou escanear o QR temporário.',
    'Enter the code and the temporary key':
        'Insira o código e a chave temporária',
    'Temporary code': 'Código temporário',
    'Access key': 'Chave de acesso',
    'Pairing…': 'Vinculando…',
    'Scan temporary QR': 'Escanear QR temporário',
    'Invalid or expired QR': 'QR inválido ou expirado',
    'The code is invalid, expired or already used':
        'O código é inválido, expirou ou já foi utilizado',
    'Point the camera at the pairing QR shown on the web':
        'Aponte a câmera para o QR de vinculação mostrado na web',
    'QR does not contain a SouthFarm pairing':
        'O QR não contém uma vinculação do SouthFarm',
    // Warmup
    'Start Warmup': 'Iniciar warmup',
    'Pause Warmup': 'Pausar warmup',
    'Resume Warmup': 'Retomar warmup',
    'Stop Warmup': 'Parar warmup',
    'Warmup complete': 'Warmup concluído',
    'Duration': 'Duração',
    'No sessions yet': 'Ainda não há sessões',
    '{n} sessions': '{n} sessões',
    'Scan': 'Escanear',
    'Scan accounts': 'Escanear contas',
    'Detected Instagram accounts': 'Contas do Instagram detectadas',
    'Detected TikTok accounts': 'Contas do TikTok detectadas',
    'Detected YouTube channels': 'Canais do YouTube detectados',
    'Clean accounts': 'Limpar contas',
    'Choose the scanned platforms to remove from this phone. Scan history will be preserved.':
        'Escolha as plataformas escaneadas para remover deste telefone. O histórico de escaneios será preservado.',
    'Select all': 'Selecionar tudo',
    'Clear selection': 'Limpar seleção',
    'Clean selected': 'Limpar selecionadas',
    'Cleaning accounts…': 'Limpando contas…',
    'Cleaned {n} scanned account records':
        '{n} registros de contas escaneados foram limpos',
    'Could not clean scanned accounts':
        'Não foi possível limpar as contas escaneadas',
    'Clean accounts failed: {n}': 'Falha ao limpar contas: {n}',
    'Select account...': 'Selecionar conta...',
    'Select an account first': 'Selecione uma conta primeiro',
    'No accounts found': 'Nenhuma conta encontrada',
    'Session synced to backend': 'Sessão sincronizada com o backend',
    // Accounts screen
    'Instagram Account': 'Conta do Instagram',
    'TikTok Account': 'Conta do TikTok',
    'YouTube Channel': 'Canal do YouTube',
    // Metrics / history
    'Likes': 'Curtidas',
    'Saves': 'Salvamentos',
    'Videos': 'Vídeos',
    'Platform': 'Plataforma',
  },
};
