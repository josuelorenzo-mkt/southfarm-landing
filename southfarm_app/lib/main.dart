import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:mobile_scanner/mobile_scanner.dart';

const String defaultApiBase = 'https://api.southfarm.tech/api';
String apiUrl = defaultApiBase;
String API_BASE = defaultApiBase;
const Color sfGreen = Color(0xFF34d399);
const Color sfBg = Color(0xFF0b0f0b);
const Color sfCard = Color(0xFF141a14);
const Color sfBorder = Color(0xFF1f2a1f);
const Color sfTextPrimary = Color(0xFFe8ede8);
const Color sfTextSecondary = Color(0xFF6b7f6b);
const Color sfAmber = Color(0xFFf59e0b);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Debug builds may override the API base at runtime (set via the
  // SET_API_BASE broadcast → SharedPreferences key 'api_base').
  if (kDebugMode) {
    try {
      final prefs = await SharedPreferences.getInstance();
      final override = prefs.getString('api_base')?.trim() ?? '';
      if (override.isNotEmpty) {
        apiUrl = override;
        API_BASE = override;
      }
    } catch (_) {}
  }
  runApp(const SouthFarmApp());
}

class SouthFarmApp extends StatelessWidget {
  const SouthFarmApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SouthFarm',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: sfGreen,
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: sfBg,
        inputDecorationTheme: const InputDecorationTheme(
          filled: true,
          fillColor: sfCard,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(12)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(12)),
            borderSide: BorderSide(color: sfBorder),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(12)),
            borderSide: BorderSide(color: sfGreen),
          ),
          contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        ),
      ),
      home: const SplashScreen(),
    );
  }
}

// ─── Instagram Logo Widget ───
class InstagramLogo extends StatelessWidget {
  final double size;
  const InstagramLogo({super.key, this.size = 20});

  @override
  Widget build(BuildContext context) {
    return Image.asset('assets/ig_logo.png', width: size, height: size);
  }
}

// Resolves an avatar URL coming from the backend: absolute CDN URLs are
// kept as-is, while new relative paths like /api/avatars/x.jpg are
// resolved against the API origin. API_BASE already ends in "/api", so a
// naive concatenation would produce ".../api/api/avatars/...".
String resolveAvatarUrl(String? picUrl, String apiBase) {
  final url = (picUrl ?? '').trim();
  if (url.isEmpty) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) {
    final origin = apiBase.replaceAll(RegExp(r'/api/?$'), '');
    return '$origin$url';
  }
  return url;
}

// Returns a copy of [list] sorted alphabetically by username
// (case-insensitive), so every account listing renders in a stable,
// predictable order regardless of the order in which the backend or a
// local scan returned the records. 'username' is the identity key for
// every account flow (Instagram, TikTok and YouTube included).
List<Map<String, dynamic>> sortAccountsByUsername(
  List<Map<String, dynamic>> list,
) {
  final sorted = List<Map<String, dynamic>>.from(list);
  sorted.sort(
    (a, b) => (a['username'] ?? '')
        .toString()
        .toLowerCase()
        .compareTo((b['username'] ?? '').toString().toLowerCase()),
  );
  return sorted;
}

// ─── Platform Logo Widget ───
class PlatformLogo extends StatelessWidget {
  final String platform;
  final double size;
  const PlatformLogo({super.key, required this.platform, this.size = 24});

  @override
  Widget build(BuildContext context) {
    switch (platform) {
      case 'youtube':
        return CustomPaint(
          size: Size.square(size),
          painter: _YouTubeLogoPainter(),
        );
      case 'instagram':
        return CustomPaint(
          size: Size.square(size),
          painter: _InstagramLogoPainter(),
        );
      case 'tiktok':
        // Keep the exact look the owner already recognizes as the TikTok
        // logo (white music note).
        return Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          child: Icon(Icons.music_note, color: Colors.white, size: size),
        );
      default:
        return Icon(Icons.camera_alt, size: size);
    }
  }
}

// Paints the Instagram camera glyph — rounded square outline with the
// brand gradient, concentric lens circle and top-right dot — without
// image assets.
class _InstagramLogoPainter extends CustomPainter {
  static const List<Color> _brand = [
    Color(0xFFF58529),
    Color(0xFFDD2A7B),
    Color(0xFF8134AF),
    Color(0xFFF7B500),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final stroke = (w * 0.09).clamp(1.5, 3.0).toDouble();
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..shader = SweepGradient(
        colors: [..._brand, _brand.first],
      ).createShader(Rect.fromLTWH(0, 0, w, w));
    final rect = Rect.fromLTWH(stroke / 2, stroke / 2, w - stroke, w - stroke);
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, Radius.circular(w * 0.26)),
      paint,
    );
    canvas.drawCircle(rect.center, w * 0.20, paint);
    canvas.drawCircle(
      Offset(w * 0.77, w * 0.23),
      w * 0.06,
      Paint()..color = const Color(0xFFDD2A7B),
    );
  }

  @override
  bool shouldRepaint(covariant _InstagramLogoPainter oldDelegate) => false;
}

// Paints the YouTube play-button mark — red rounded rectangle with a
// centered white triangle — without image assets.
class _YouTubeLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final rect = Rect.fromLTWH(0, h * 0.16, w, h * 0.68);
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, Radius.circular(w * 0.24)),
      Paint()..color = const Color(0xFFFF0000),
    );
    final center = rect.center;
    final t = w * 0.16;
    final path =
        Path()
          ..moveTo(center.dx - t * 0.7, center.dy - t)
          ..lineTo(center.dx + t, center.dy)
          ..lineTo(center.dx - t * 0.7, center.dy + t)
          ..close();
    canvas.drawPath(path, Paint()..color = Colors.white);
  }

  @override
  bool shouldRepaint(covariant _YouTubeLogoPainter oldDelegate) => false;
}

// ─── SouthFarm Logo Widget ───
class SouthFarmLogo extends StatelessWidget {
  final double fontSize;
  final IconData leafIcon;
  const SouthFarmLogo({
    super.key,
    this.fontSize = 24,
    this.leafIcon = Icons.eco,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(leafIcon, color: sfGreen, size: fontSize * 0.9),
        const SizedBox(width: 8),
        RichText(
          text: TextSpan(
            style: TextStyle(
              fontSize: fontSize,
              fontWeight: FontWeight.bold,
              color: sfTextPrimary,
            ),
            children: const [
              TextSpan(
                text: 'South',
                style: TextStyle(color: sfGreen),
              ),
              TextSpan(
                text: 'Farm',
                style: TextStyle(color: sfTextPrimary),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ─── MethodChannel Helper ───
class WarmupApi {
  static const _channel = MethodChannel('com.example.southfarm_app/warmup');

  static Future<bool> startWarmup(
    String username,
    int duration, {
    String platform = 'instagram',
    String sourceAccountName = '',
    String sourceAccountEmail = '',
    String channelDisplayName = '',
  }) async {
    final result = await _channel.invokeMethod<bool>('startWarmup', {
      'username': username,
      'duration': duration,
      'platform': platform,
      if (sourceAccountName.isNotEmpty)
        'source_account_name': sourceAccountName,
      if (sourceAccountEmail.isNotEmpty)
        'source_account_email': sourceAccountEmail,
      if (channelDisplayName.isNotEmpty)
        'channel_display_name': channelDisplayName,
    });
    return result ?? false;
  }

  static Future<bool> stopWarmup() async {
    final result = await _channel.invokeMethod<bool>('stopWarmup');
    return result ?? false;
  }

  static Future<bool> pauseWarmup() async {
    final result = await _channel.invokeMethod<bool>('pauseWarmup');
    return result ?? false;
  }

  static Future<bool> pauseWarmupAndReturn() async {
    final result = await _channel.invokeMethod<bool>('pauseWarmupAndReturn');
    return result ?? false;
  }

  static Future<bool> resumeWarmup() async {
    final result = await _channel.invokeMethod<bool>('resumeWarmup');
    return result ?? false;
  }

  static Future<String> getStatus() async {
    final result = await _channel.invokeMethod<String>('getStatus');
    return result ?? 'unknown';
  }

  static Future<String> getMetrics() async {
    final result = await _channel.invokeMethod<String>('getMetrics');
    return result ?? '{}';
  }

  static Future<void> ackFinished() async {
    try {
      await _channel.invokeMethod<bool>('ackFinished');
    } catch (_) {}
  }

  static Future<bool> isServiceRunning() async {
    final result = await _channel.invokeMethod<bool>('isServiceRunning');
    return result ?? false;
  }

  static Future<bool> isAccessibilityEnabled() async {
    final result = await _channel.invokeMethod<bool>('isAccessibilityEnabled');
    return result ?? false;
  }

  static Future<bool> openAccessibilitySettings() async {
    final result = await _channel.invokeMethod<bool>(
      'openAccessibilitySettings',
    );
    return result ?? false;
  }

  static Future<bool> isOverlayPermissionGranted() async {
    final result = await _channel.invokeMethod<bool>(
      'isOverlayPermissionGranted',
    );
    return result ?? false;
  }

  static Future<bool> requestOverlayPermission() async {
    final result = await _channel.invokeMethod<bool>(
      'requestOverlayPermission',
    );
    return result ?? false;
  }

  static Future<bool> startOverlay() async {
    final result = await _channel.invokeMethod<bool>('startOverlay');
    return result ?? false;
  }

  static Future<bool> stopOverlay() async {
    final result = await _channel.invokeMethod<bool>('stopOverlay');
    return result ?? false;
  }

  static Future<String> detectAccounts({String platform = 'instagram'}) async {
    final result = await _channel.invokeMethod<String>('detectAccounts', {
      'platform': platform,
    });
    return result ?? '[]';
  }

  static Future<List<Map<String, dynamic>>> getLocalAccounts(
    String platform,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    final key = _accountCacheKey(platform);
    final raw = prefs.getString(key) ?? '[]';
    try {
      final decoded = jsonDecode(raw) as List;
      return decoded
          .map((item) {
            if (item is Map) {
              final account = Map<String, dynamic>.from(item);
              account['username'] = (account['username'] ?? '')
                  .toString()
                  .replaceFirst(RegExp(r'^@'), '');
              // Do NOT inject a default profile_pic_url here: an empty value
              // must not clobber the backend's URL during merge (backend is
              // the source of truth for avatars).
              return account;
            }
            return <String, dynamic>{
              'username': item.toString().replaceFirst(RegExp(r'^@'), ''),
            };
          })
          .where((item) => (item['username'] as String).isNotEmpty)
          .toList();
    } catch (_) {
      return [];
    }
  }

  static List<Map<String, dynamic>> mergeAccountMetadata(
    List<Map<String, dynamic>> detected,
    List<Map<String, dynamic>> backend,
  ) {
    final byUsername = <String, Map<String, dynamic>>{};
    for (final account in backend) {
      final username = (account['username'] ?? '')
          .toString()
          .replaceFirst(RegExp(r'^@'), '')
          .trim()
          .toLowerCase();
      if (username.isNotEmpty) {
        byUsername[username] = Map<String, dynamic>.from(account);
      }
    }

    final merged = <Map<String, dynamic>>[];
    for (final account in detected) {
      final username = (account['username'] ?? '')
          .toString()
          .replaceFirst(RegExp(r'^@'), '')
          .trim()
          .toLowerCase();
      if (username.isEmpty) continue;
      // Detected metadata is newer and more complete than an older backend
      // response that may only contain username/profile_pic_url.
      final value = <String, dynamic>{
        ...(byUsername[username] ?? <String, dynamic>{}),
        ...account,
      };
      // Profile pictures are the exception: the backend is the source of
      // truth, and a locally cached entry may carry an empty value that
      // must not clobber a valid backend URL.
      if ((value['profile_pic_url'] ?? '').toString().trim().isEmpty) {
        final backendPic =
            (byUsername[username]?['profile_pic_url'] ?? '')
                .toString()
                .trim();
        if (backendPic.isNotEmpty) {
          value['profile_pic_url'] = backendPic;
        }
      }
      value['username'] = (value['username'] ?? username)
          .toString()
          .replaceFirst(RegExp(r'^@'), '');
      merged.add(value);
      byUsername.remove(username);
    }
    merged.addAll(byUsername.values);
    return merged;
  }

  static String _accountCacheKey(String platform) {
    switch (platform) {
      case 'tiktok':
        return 'tiktok_accounts';
      case 'youtube':
        return 'youtube_channels';
      default:
        return 'detected_accounts';
    }
  }

  // ─── Backend API helpers ───
  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('device_token') ?? prefs.getString('auth_token');
  }

  static Future<String> getDeviceId() async {
    // Always use the real ANDROID_ID from the device, never from cached prefs
    try {
      final info = await MethodChannel(
        'com.example.southfarm_app/warmup',
      ).invokeMethod<Map>('getDeviceInfo');
      if (info != null && info['device_id'] != null) {
        final realId = info['device_id']! as String;
        // Keep prefs in sync
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('device_id', realId);
        return realId;
      }
    } catch (_) {}
    // Fallback to prefs only if MethodChannel fails
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('device_id') ??
        prefs.getString('stable_device_id') ??
        'unknown';
  }

  static Future<void> syncAccountsToBackend(
    List<dynamic> accounts, {
    String platform = 'instagram',
  }) async {
    final token = await getToken();
    final deviceId = await getDeviceId();
    if (token == null) {
      print('[SouthFarm] syncAccounts: no token');
      return;
    }
    try {
      final normalizedAccounts = accounts
          .map<Map<String, dynamic>>((item) {
            if (item is Map) {
              final account = Map<String, dynamic>.from(item);
              account['username'] = (account['username'] ?? '')
                  .toString()
                  .replaceFirst(RegExp(r'^@'), '')
                  .trim();
              return account;
            }
            return <String, dynamic>{
              'username': item
                  .toString()
                  .replaceFirst(RegExp(r'^@'), '')
                  .trim(),
            };
          })
          .where((account) => (account['username'] ?? '').toString().isNotEmpty)
          .toList();
      final res = await http
          .post(
            Uri.parse('$API_BASE/social-accounts'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'device_id': deviceId,
              'accounts': normalizedAccounts,
              'platform': platform,
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 201) {
        print('[SouthFarm] syncAccounts FAILED: ${res.statusCode} ${res.body}');
      } else {
        print(
          '[SouthFarm] syncAccounts OK: ${normalizedAccounts.length} $platform accounts synced for device $deviceId',
        );
      }
    } catch (e) {
      print('[SouthFarm] syncAccounts ERROR: $e');
    }
  }

  static Future<List<Map<String, dynamic>>> getAccountsFromBackend({
    String platform = 'instagram',
  }) async {
    final token = await getToken();
    final deviceId = await getDeviceId();
    if (token == null) return [];
    try {
      final res = await http
          .get(
            Uri.parse(
              '$API_BASE/social-accounts?device_id=$deviceId&platform=$platform',
            ),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final accounts = (data['accounts'] as List)
            .cast<Map<String, dynamic>>();
        print(
          '[SouthFarm] getAccounts: ${accounts.length} accounts for device $deviceId',
        );
        // A successful empty backend response is authoritative. Remove the
        // local fallback too, otherwise a web-side Clean accounts action would
        // appear to do nothing when the mobile screen is reopened.
        if (accounts.isEmpty) {
          final prefs = await SharedPreferences.getInstance();
          await prefs.remove(_accountCacheKey(platform));
        }
        return accounts;
      } else {
        print('[SouthFarm] getAccounts FAILED: ${res.statusCode}');
      }
    } catch (e) {
      print('[SouthFarm] getAccounts ERROR: $e');
    }
    return [];
  }

  static Future<Map<String, dynamic>> clearAccounts({
    required List<String> platforms,
  }) async {
    final token = await getToken();
    final deviceId = await getDeviceId();
    if (token == null) throw Exception('No authentication token');
    final response = await http
        .delete(
          Uri.parse('$API_BASE/social-accounts'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({'platforms': platforms, 'device_id': deviceId}),
        )
        .timeout(const Duration(seconds: 15));
    final data = response.body.isNotEmpty ? jsonDecode(response.body) : {};
    if (response.statusCode != 200) {
      throw Exception(
        data is Map && data['error'] != null
            ? data['error'].toString()
            : 'Could not clean scanned accounts',
      );
    }
    return data is Map<String, dynamic>
        ? data
        : Map<String, dynamic>.from(data as Map);
  }
}

// ─── Splash ───
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _fadeAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );
    _fadeAnim = CurvedAnimation(parent: _controller, curve: Curves.easeIn);
    _controller.forward();
    _checkOnboarding();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _checkOnboarding() async {
    await Future.delayed(const Duration(seconds: 2));
    final prefs = await SharedPreferences.getInstance();
    final done = prefs.getBool('onboarding_done') ?? false;
    if (!mounted) return;

    if (!done) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const OnboardingScreen()),
      );
    } else {
      final token = await AuthService.getValidAuthToken();
      if (!mounted) return;
      if (token == null) {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => const AuthScreen()),
        );
      } else {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => const MainScreen()),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: FadeTransition(
        opacity: _fadeAnim,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SouthFarmLogo(fontSize: 40, leafIcon: Icons.local_florist),
              const SizedBox(height: 12),
              const Text(
                'Mobile automation',
                style: TextStyle(color: sfTextSecondary, fontSize: 16),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─── Onboarding ───
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  int _step = 0;

  final List<_OBStep> _steps = [
    _OBStep(
      Icons.local_florist,
      'Welcome to SouthFarm',
      'Automate tasks on your phone.\nWarmups, posts, and more.',
    ),
    _OBStep(
      Icons.security,
      'Enable Accessibility',
      'SouthFarm needs accessibility permission\nto simulate screen taps.',
    ),
    _OBStep(
      Icons.layers,
      'Enable Overlay',
      'You will see a protective layer when\nSouthFarm is working.',
    ),
    _OBStep(
      Icons.check_circle,
      'All set!',
      'Set up your tasks and get started.\nsouthfarm.tech',
    ),
  ];

  void _next() async {
    if (_step == 1) {
      final enabled = await WarmupApi.isAccessibilityEnabled();
      if (!enabled) {
        await WarmupApi.openAccessibilitySettings();
        return;
      }
    }
    if (_step == 2) {
      final granted = await WarmupApi.isOverlayPermissionGranted();
      if (!granted) {
        await WarmupApi.requestOverlayPermission();
        return;
      }
    }
    if (_step < _steps.length - 1) {
      setState(() => _step++);
    } else {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('onboarding_done', true);
      final token = await AuthService.getValidAuthToken();
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) =>
              token == null ? const AuthScreen() : const MainScreen(),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _steps[_step];
    return Scaffold(
      backgroundColor: sfBg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            children: [
              const Spacer(flex: 2),
              Container(
                width: 100,
                height: 100,
                decoration: BoxDecoration(
                  color: sfGreen.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(color: sfGreen.withValues(alpha: 0.2)),
                ),
                child: Icon(s.icon, size: 48, color: sfGreen),
              ),
              const SizedBox(height: 32),
              Text(
                s.title,
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: sfTextPrimary,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                s.desc,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 16, color: sfTextSecondary),
              ),
              if (_step == 1 || _step == 2) ...[
                const SizedBox(height: 24),
                Text(
                  _step == 1
                      ? 'Tap the button and enable SouthFarm in Accessibility'
                      : 'Tap the button and allow SouthFarm over other apps',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: sfAmber, fontSize: 14),
                ),
              ],
              const Spacer(flex: 3),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(
                  _steps.length,
                  (i) => Container(
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    width: i == _step ? 24 : 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: i == _step ? sfGreen : sfBorder,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _next,
                  style: FilledButton.styleFrom(
                    backgroundColor: sfGreen,
                    foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    textStyle: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  child: Text(
                    _step < _steps.length - 1 ? 'Enable' : 'Get Started',
                  ),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }
}

class _OBStep {
  final IconData icon;
  final String title;
  final String desc;
  const _OBStep(this.icon, this.title, this.desc);
}

enum DeviceRegistrationResult { success, notPaired, authRequired, unavailable }

// ─── Auth Service ───
class AuthService {
  static bool lastAuthSessionExpired = false;
  static Future<String?>? _refreshInFlight;
  static bool _logoutInFlight = false;

  // Serializes every session-state mutation (login, refresh, logout, device
  // registration) through the single SharedPreferences singleton so writes
  // from different flows can never interleave with each other.
  static Future<void> _sessionQueue = Future.value();

  static Future<T> _enqueue<T>(Future<T> Function() action) {
    final result = _sessionQueue.then((_) => action());
    _sessionQueue = result.then((_) {}, onError: (_) {});
    return result;
  }

  static void _logSessionEvent(String action, String key, String reason) {
    debugPrint(
      '[Auth] session $action $key reason=$reason at ${DateTime.now().toIso8601String()}',
    );
  }

  static Future<void> _setSessionKey(
    SharedPreferences prefs,
    String key,
    String value,
    String reason,
  ) async {
    await prefs.setString(key, value);
    _logSessionEvent('set', key, reason);
  }

  static Future<void> _removeSessionKey(
    SharedPreferences prefs,
    String key,
    String reason,
  ) async {
    await prefs.remove(key);
    _logSessionEvent('remove', key, reason);
  }

  static Future<void> _setDevicePaired(
    SharedPreferences prefs,
    bool value,
    String reason,
  ) async {
    await prefs.setBool('device_paired', value);
    _logSessionEvent('set', 'device_paired', reason);
  }

  static Future<void> _clearUserSessionKeys(
    SharedPreferences prefs,
    String reason,
  ) async {
    for (final key in [
      'auth_token',
      'refresh_token',
      'user_email',
      'user_name',
    ]) {
      await prefs.remove(key);
      _logSessionEvent('remove', key, reason);
    }
  }

  static Future<void> _persistAuth(
    SharedPreferences prefs,
    Map<String, dynamic> data, {
    String? fallbackEmail,
    required String reason,
  }) async {
    final token = data['token']?.toString();
    final refreshToken = data['refresh_token']?.toString();
    if (token == null || token.isEmpty) {
      throw const FormatException('Auth response did not include a token');
    }
    await _setSessionKey(prefs, 'auth_token', token, reason);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _setSessionKey(prefs, 'refresh_token', refreshToken, reason);
    }
    final user = data['user'];
    if (user is Map) {
      final email = user['email']?.toString();
      final name = user['name']?.toString();
      if (email != null && email.isNotEmpty) await prefs.setString('user_email', email);
      if (name != null && name.isNotEmpty) await prefs.setString('user_name', name);
    } else if (fallbackEmail != null && fallbackEmail.isNotEmpty) {
      await prefs.setString('user_email', fallbackEmail);
    }
    lastAuthSessionExpired = false;
  }

  static Future<bool> register(
    String email,
    String password,
    String name,
  ) async {
    try {
      final res = await http.post(
        Uri.parse('$API_BASE/auth/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password, 'name': name}),
      );
      if (res.statusCode == 201) {
        final data = Map<String, dynamic>.from(jsonDecode(res.body) as Map);
        await _enqueue(() async {
          final prefs = await SharedPreferences.getInstance();
          await _persistAuth(prefs, data, fallbackEmail: email, reason: 'register');
        });
        return true;
      }
      return false;
    } catch (e) {
      print('[Auth] Register error: $e');
      return false;
    }
  }

  static Future<bool> login(String email, String password) async {
    try {
      final res = await http.post(
        Uri.parse('$API_BASE/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password}),
      );
      if (res.statusCode == 200) {
        final data = Map<String, dynamic>.from(jsonDecode(res.body) as Map);
        await _enqueue(() async {
          final prefs = await SharedPreferences.getInstance();
          await _persistAuth(prefs, data, fallbackEmail: email, reason: 'login');
        });
        return true;
      }
      return false;
    } catch (e) {
      print('[Auth] Login error: $e');
      return false;
    }
  }

  static Future<void> logout() async {
    if (_logoutInFlight) return;
    _logoutInFlight = true;
    try {
      final activeRefresh = _refreshInFlight;
      if (activeRefresh != null) {
        await activeRefresh.catchError((_) {});
      }
      await _enqueue(() async {
        final prefs = await SharedPreferences.getInstance();
        final refreshToken = prefs.getString('refresh_token');
        if (refreshToken != null && refreshToken.isNotEmpty) {
          try {
            await http.post(
              Uri.parse('$API_BASE/auth/logout'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({'refresh_token': refreshToken}),
            ).timeout(const Duration(seconds: 10));
          } catch (_) {}
        }
        await _clearUserSessionKeys(prefs, 'logout');
      });
    } finally {
      _logoutInFlight = false;
    }
  }

  static Future<String?> getToken() => getValidAuthToken();

  static bool _tokenNeedsRefresh(String token) {
    try {
      final parts = token.split('.');
      if (parts.length < 2) return true;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      final exp = int.tryParse(payload['exp']?.toString() ?? '');
      if (exp == null) return true;
      return exp <= DateTime.now().millisecondsSinceEpoch ~/ 1000 + 60;
    } catch (_) {
      return true;
    }
  }

  static Future<String?> _performRefresh() async {
    final prefs = await SharedPreferences.getInstance();
    final refreshToken = prefs.getString('refresh_token');
    if (refreshToken == null || refreshToken.isEmpty) {
      lastAuthSessionExpired = true;
      return null;
    }
    try {
      final res = await http.post(
        Uri.parse('$API_BASE/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refresh_token': refreshToken}),
      ).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        final data = Map<String, dynamic>.from(jsonDecode(res.body) as Map);
        final applied = await _enqueue(() async {
          try {
            final p = await SharedPreferences.getInstance();
            // The refresh token must still be the one this refresh used. A
            // concurrent login/logout replaced the session while the HTTP call
            // was in flight, so this stale response must not overwrite it.
            if (p.getString('refresh_token') != refreshToken) return false;
            await _persistAuth(p, data, reason: 'refresh');
            return true;
          } catch (e) {
            _logSessionEvent('error', 'refresh', 'malformedResponse: $e');
            return null;
          }
        });
        return applied == true ? data['token']?.toString() : null;
      }
      if (res.statusCode == 401 || res.statusCode == 403) {
        lastAuthSessionExpired = true;
        await _enqueue(() async {
          final p = await SharedPreferences.getInstance();
          await _removeSessionKey(p, 'auth_token', 'refreshRejected');
          await _removeSessionKey(p, 'refresh_token', 'refreshRejected');
        });
      }
    } catch (e) {
      print('[Auth] Refresh error: $e');
    }
    return null;
  }

  static Future<String?> refreshSession() async {
    final activeRefresh = _refreshInFlight;
    if (activeRefresh != null) return activeRefresh;
    final future = _performRefresh();
    _refreshInFlight = future;
    try {
      return await future;
    } finally {
      if (identical(_refreshInFlight, future)) _refreshInFlight = null;
    }
  }

  static Future<String?> getValidAuthToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('auth_token');
    if (token == null || token.isEmpty) return null;
    if (!_tokenNeedsRefresh(token)) return token;
    return refreshSession();
  }

  static Future<String> ensureInstallationId() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString('installation_id');
    if (existing != null && existing.isNotEmpty) return existing;
    final random = math.Random.secure();
    final id =
        'sf-install-${List.generate(24, (_) => random.nextInt(16).toRadixString(16)).join()}';
    await prefs.setString('installation_id', id);
    return id;
  }

  static Future<DeviceRegistrationResult> registerDevice() async {
    lastAuthSessionExpired = false;
    try {
      final token = await getValidAuthToken();
      if (token == null) {
        return lastAuthSessionExpired
            ? DeviceRegistrationResult.authRequired
            : DeviceRegistrationResult.unavailable;
      }

      final deviceInfo = await _getDeviceInfo();

      final res = await http.post(
        Uri.parse('$API_BASE/devices/register'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: jsonEncode({
          'device_id': deviceInfo['device_id']!,
          'installation_id': deviceInfo['installation_id'],
          'device_name': deviceInfo['device_name'],
          'android_version': deviceInfo['android_version'],
          'app_version': deviceInfo['app_version'],
        }),
      );
      final data = res.body.isNotEmpty
          ? jsonDecode(res.body)
          : <String, dynamic>{};

      if (res.statusCode == 200 || res.statusCode == 201) {
        await _enqueue(() async {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('device_id', deviceInfo['device_id']!);
          if (data is Map && data['device_token'] != null) {
            await _setSessionKey(
              prefs,
              'device_token',
              data['device_token'].toString(),
              'registerDevice',
            );
          }
          await _setDevicePaired(prefs, true, 'registerDevice');
        });
        print('[Device] Registered: ${deviceInfo['device_name']}');
        return DeviceRegistrationResult.success;
      } else {
        print('[Device] Register failed: ${res.statusCode} ${res.body}');
        if (res.statusCode == 401) {
          lastAuthSessionExpired = true;
          return DeviceRegistrationResult.authRequired;
        }
        if (res.statusCode == 409) {
          final code = data is Map ? data['code']?.toString() : null;
          if (code == 'DEVICE_NOT_PAIRED') return DeviceRegistrationResult.notPaired;
        }
      }
    } catch (e) {
      print('[Device] Register error: $e');
    }
    return DeviceRegistrationResult.unavailable;
  }

  static Future<bool> claimDevice({
    required String code,
    required String accessKey,
  }) async {
    try {
      final token = await getValidAuthToken();
      if (token == null) return false;
      final deviceInfo = await _getDeviceInfo();
      final res = await http.post(
        Uri.parse('$API_BASE/devices/claim'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: jsonEncode({
          'code': code.trim().toUpperCase(),
          'access_key': accessKey.trim(),
          ...deviceInfo,
        }),
      );
      final data = res.body.isNotEmpty
          ? jsonDecode(res.body)
          : <String, dynamic>{};
      if (res.statusCode != 201 || data is! Map) {
        print('[Device] Pair failed: ${res.statusCode} ${res.body}');
        return false;
      }
      await _enqueue(() async {
        final prefs = await SharedPreferences.getInstance();
        await _setDevicePaired(prefs, true, 'claimDevice');
        await prefs.setString('device_id', deviceInfo['device_id']!);
        if (data['device_token'] != null) {
          await _setSessionKey(
            prefs,
            'device_token',
            data['device_token'].toString(),
            'claimDevice',
          );
        }
      });
      return true;
    } catch (e) {
      print('[Device] Pair error: $e');
      return false;
    }
  }

  static Future<Map<String, String>> _getDeviceInfo() async {
    final installationId = await ensureInstallationId();
    try {
      final info = await MethodChannel(
        'com.example.southfarm_app/warmup',
      ).invokeMethod<Map>('getDeviceInfo');
      if (info != null) {
        final result = Map<String, String>.from(info);
        result['installation_id'] = installationId;
        return result;
      }
    } catch (e) {
      print('[Device] MethodChannel error: $e');
    }
    final prefs = await SharedPreferences.getInstance();
    var deviceId = prefs.getString('stable_device_id');
    if (deviceId == null) {
      deviceId = 'sf-${DateTime.now().millisecondsSinceEpoch}';
      await prefs.setString('stable_device_id', deviceId);
    }
    return {
      'device_id': deviceId,
      'installation_id': installationId,
      'device_name': 'Unknown',
      'android_version': '?',
    };
  }

  static Future<Map<String, dynamic>?> checkPendingTasks() async {
    try {
      final token = await AuthService.getValidAuthToken();
      if (token == null) return null;

      final res = await http.get(
        Uri.parse('$API_BASE/tasks/runs?status=pending&limit=1'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final runs = data['runs'] as List?;
        if (runs != null && runs.isNotEmpty) {
          return runs.first as Map<String, dynamic>;
        }
      }
    } catch (e) {
      print('[Tasks] Check error: $e');
    }
    return null;
  }
}

// ─── Auth Screen ───
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  bool _isLogin = true;
  bool _loading = false;
  String? _error;
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();

  Future<void> _submit() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final email = _emailCtrl.text.trim();
    final pass = _passCtrl.text;
    final name = _nameCtrl.text.trim();

    if (email.isEmpty || pass.isEmpty || (!_isLogin && name.isEmpty)) {
      setState(() {
        _error = 'Please fill in all fields';
        _loading = false;
      });
      return;
    }

    bool ok;
    if (_isLogin) {
      ok = await AuthService.login(email, pass);
    } else {
      ok = await AuthService.register(email, pass, name);
    }

    if (!mounted) return;
    if (ok) {
      final registration = await AuthService.registerDevice();
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) =>
              registration == DeviceRegistrationResult.notPaired
                  ? const DevicePairingScreen()
                  : const MainScreen(),
        ),
      );
    } else {
      setState(() {
        _error = _isLogin
            ? 'Incorrect email or password'
            : 'Error creating account. Already exists?';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SouthFarmLogo(fontSize: 32, leafIcon: Icons.eco),
              const SizedBox(height: 32),

              Container(
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: sfCard,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: _tabBtn(
                        'Log In',
                        _isLogin,
                        () => setState(() => _isLogin = true),
                      ),
                    ),
                    Expanded(
                      child: _tabBtn(
                        'Sign Up',
                        !_isLogin,
                        () => setState(() => _isLogin = false),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              if (!_isLogin) ...[
                TextField(
                  controller: _nameCtrl,
                  style: const TextStyle(color: sfTextPrimary),
                  decoration: const InputDecoration(
                    hintText: 'Name',
                    hintStyle: TextStyle(color: sfTextSecondary),
                  ),
                ),
                const SizedBox(height: 12),
              ],

              TextField(
                controller: _emailCtrl,
                keyboardType: TextInputType.emailAddress,
                style: const TextStyle(color: sfTextPrimary),
                decoration: const InputDecoration(
                  hintText: 'Email',
                  hintStyle: TextStyle(color: sfTextSecondary),
                ),
              ),
              const SizedBox(height: 12),

              TextField(
                controller: _passCtrl,
                obscureText: true,
                style: const TextStyle(color: sfTextPrimary),
                decoration: const InputDecoration(
                  hintText: 'Password',
                  hintStyle: TextStyle(color: sfTextSecondary),
                ),
              ),
              const SizedBox(height: 24),

              if (_error != null) ...[
                Text(
                  _error!,
                  style: const TextStyle(color: Colors.redAccent, fontSize: 13),
                ),
                const SizedBox(height: 12),
              ],

              SizedBox(
                width: double.infinity,
                height: 50,
                child: ElevatedButton(
                  onPressed: _loading ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: sfGreen,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _loading
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.black,
                          ),
                        )
                      : Text(
                          _isLogin ? 'Log In' : 'Sign Up',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tabBtn(String text, bool active, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: active ? sfGreen : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: active ? Colors.black : sfTextSecondary,
            fontWeight: FontWeight.w600,
            fontSize: 14,
          ),
        ),
      ),
    );
  }
}

// ─── Device Pairing ───
class DevicePairingScreen extends StatefulWidget {
  const DevicePairingScreen({super.key});

  @override
  State<DevicePairingScreen> createState() => _DevicePairingScreenState();
}

class _DevicePairingScreenState extends State<DevicePairingScreen> {
  final _codeCtrl = TextEditingController();
  final _keyCtrl = TextEditingController();
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _codeCtrl.dispose();
    _keyCtrl.dispose();
    super.dispose();
  }

  void _applyQrPayload(String raw) {
    try {
      Map<String, dynamic>? payload;
      final trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        final decoded = jsonDecode(trimmed);
        if (decoded is Map) payload = Map<String, dynamic>.from(decoded);
      } else {
        final uri = Uri.tryParse(trimmed);
        if (uri != null) {
          payload = {
            ...uri.queryParameters,
            if (uri.fragment.isNotEmpty) ...Uri.splitQueryString(uri.fragment),
          };
        }
      }
      final code = payload?['code'] ?? payload?['pairing_code'];
      final accessKey = payload?['access_key'] ?? payload?['key'];
      if (code == null || accessKey == null) {
        throw const FormatException('QR does not contain a SouthFarm pairing');
      }
      _codeCtrl.text = code.toString().toUpperCase();
      _keyCtrl.text = accessKey.toString();
      setState(() => _error = null);
    } catch (e) {
      setState(() => _error = 'QR inválido o vencido');
    }
  }

  Future<void> _scanQr() async {
    final raw = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const QrPairingScannerScreen()),
    );
    if (raw != null && mounted) _applyQrPayload(raw);
  }

  Future<void> _pair() async {
    final code = _codeCtrl.text.trim();
    final accessKey = _keyCtrl.text.trim();
    if (code.isEmpty || accessKey.isEmpty) {
      setState(() => _error = 'Ingresá el código y la llave temporal');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    final ok = await AuthService.claimDevice(code: code, accessKey: accessKey);
    if (!mounted) return;
    if (ok) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const MainScreen()),
      );
    } else {
      setState(() {
        _loading = false;
        _error = 'El código no es válido, venció o ya fue utilizado';
      });
    }
  }

  Future<void> _logout() async {
    await AuthService.logout();
    if (!mounted) return;
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (_) => const AuthScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      appBar: AppBar(
        backgroundColor: sfBg,
        title: const Text('Vincular celular'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _logout,
            icon: const Icon(Icons.logout),
            tooltip: 'Cerrar sesión',
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.phonelink_setup, size: 72, color: sfGreen),
              const SizedBox(height: 20),
              const Text(
                'Este celular todavía no está vinculado a tu workspace.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: sfTextPrimary,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'Generá un código desde Device fleet en la web. Podés ingresar la llave manualmente o escanear el QR temporal.',
                textAlign: TextAlign.center,
                style: TextStyle(color: sfTextSecondary, height: 1.4),
              ),
              const SizedBox(height: 28),
              TextField(
                controller: _codeCtrl,
                textCapitalization: TextCapitalization.characters,
                style: const TextStyle(color: sfTextPrimary),
                decoration: const InputDecoration(
                  labelText: 'Código temporal',
                  prefixIcon: Icon(Icons.password),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _keyCtrl,
                style: const TextStyle(color: sfTextPrimary),
                decoration: const InputDecoration(
                  labelText: 'Llave de acceso',
                  prefixIcon: Icon(Icons.key),
                ),
              ),
              const SizedBox(height: 18),
              OutlinedButton.icon(
                onPressed: _loading ? null : _scanQr,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Escanear QR temporal'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.redAccent),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: _loading ? null : _pair,
                icon: _loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.link),
                label: Text(_loading ? 'Vinculando…' : 'Vincular celular'),
                style: FilledButton.styleFrom(
                  backgroundColor: sfGreen,
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 15),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class QrPairingScannerScreen extends StatefulWidget {
  const QrPairingScannerScreen({super.key});

  @override
  State<QrPairingScannerScreen> createState() => _QrPairingScannerScreenState();
}

class _QrPairingScannerScreenState extends State<QrPairingScannerScreen> {
  bool _returned = false;

  void _onDetect(BarcodeCapture capture) {
    if (_returned) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw != null && raw.trim().isNotEmpty) {
        _returned = true;
        Navigator.pop(context, raw);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: const Text('Escanear QR'),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(onDetect: _onDetect),
          Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: sfGreen, width: 3),
                borderRadius: BorderRadius.circular(20),
              ),
            ),
          ),
          const Positioned(
            left: 24,
            right: 24,
            bottom: 40,
            child: Text(
              'Apuntá al QR de vinculación que muestra la web',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white, fontSize: 16),
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Main Screen (with bottom nav) ───
class MainScreen extends StatefulWidget {
  const MainScreen({super.key});
  @override
  State<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends State<MainScreen> with WidgetsBindingObserver {
  int _currentIndex = 0;
  final _historyKey = GlobalKey<State<HistoryScreen>>();
  String _userName = '';
  bool _accessibilityEnabled = false;
  bool _serviceRunning = false;
  bool _ensureDeviceRunning = false;
  Timer? _serviceHealthTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadUser();
    _ensureDevice();
    _refreshServiceHealth();
    _serviceHealthTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _refreshServiceHealth(),
    );
  }

  @override
  void dispose() {
    _serviceHealthTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _refreshServiceHealth();
      _ensureDevice();
    }
  }

  Future<void> _refreshServiceHealth() async {
    var accessibilityEnabled = false;
    var serviceRunning = false;
    try {
      accessibilityEnabled = await WarmupApi.isAccessibilityEnabled();
      serviceRunning = accessibilityEnabled && await WarmupApi.isServiceRunning();
    } catch (_) {}
    if (!mounted) return;
    if (_accessibilityEnabled != accessibilityEnabled ||
        _serviceRunning != serviceRunning) {
      setState(() {
        _accessibilityEnabled = accessibilityEnabled;
        _serviceRunning = serviceRunning;
      });
    }
  }

  Future<void> _loadUser() async {
    final prefs = await SharedPreferences.getInstance();
    if (mounted) setState(() => _userName = prefs.getString('user_name') ?? '');
  }

  Future<void> _ensureDevice() async {
    if (_ensureDeviceRunning) return;
    _ensureDeviceRunning = true;
    try {
      final registration = await AuthService.registerDevice();
      if (mounted) {
        if (registration == DeviceRegistrationResult.notPaired) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(builder: (_) => const DevicePairingScreen()),
          );
        } else if (registration == DeviceRegistrationResult.authRequired) {
          Navigator.pushReplacement(
            context,
            MaterialPageRoute(builder: (_) => const AuthScreen()),
          );
        }
      }
    } finally {
      _ensureDeviceRunning = false;
    }
  }

  void _showLogoutDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: sfCard,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text(
          'Log out',
          style: TextStyle(color: sfTextPrimary, fontSize: 18),
        ),
        content: Text(
          'Do you want to log out, $_userName?',
          style: const TextStyle(color: sfTextSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text(
              'Cancel',
              style: TextStyle(color: sfTextSecondary),
            ),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await AuthService.logout();
              if (mounted) {
                Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(builder: (_) => const AuthScreen()),
                );
              }
            },
            child: const Text(
              'Log out',
              style: TextStyle(color: Colors.redAccent),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: Column(
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(20, 48, 20, 16),
            child: Row(
              children: [
                const SouthFarmLogo(fontSize: 24, leafIcon: Icons.eco),
                const Spacer(),
                GestureDetector(
                  onTap: () => _showLogoutDialog(),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: sfCard,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: sfBorder),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircleAvatar(
                          radius: 12,
                          backgroundColor: sfGreen.withValues(alpha: 0.2),
                          child: Icon(Icons.person, size: 16, color: sfGreen),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          _userName,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: sfTextPrimary,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Icon(
                          Icons.chevron_right,
                          size: 16,
                          color: sfTextSecondary,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (!_accessibilityEnabled || !_serviceRunning)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: sfAmber.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: sfAmber.withValues(alpha: 0.45)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded, color: sfAmber),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        !_accessibilityEnabled
                            ? 'Accessibility is disabled. Remote tasks cannot run.'
                            : 'SouthFarm service is not running. Re-enable Accessibility to receive remote tasks.',
                        style: const TextStyle(
                          color: sfTextPrimary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () async {
                        await WarmupApi.openAccessibilitySettings();
                        await _refreshServiceHealth();
                      },
                      child: const Text('Fix'),
                    ),
                  ],
                ),
              ),
            ),
          Expanded(
            child: IndexedStack(
              index: _currentIndex,
              children: [
                const WarmupScreen(),
                const AccountsScreen(),
                HistoryScreen(key: _historyKey),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: sfCard,
        selectedItemColor: sfGreen,
        unselectedItemColor: sfTextSecondary,
        currentIndex: _currentIndex,
        onTap: (i) {
          setState(() => _currentIndex = i);
          if (i == 2) {
            final state = _historyKey.currentState;
            if (state != null) {
              (state as dynamic).reload();
            }
          }
        },
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.play_circle),
            label: 'Warmup',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.person_outline),
            label: 'Accounts',
          ),
          BottomNavigationBarItem(icon: Icon(Icons.history), label: 'History'),
        ],
      ),
    );
  }
}

// ─── Warmup Screen ───
class WarmupScreen extends StatefulWidget {
  const WarmupScreen({super.key});
  @override
  State<WarmupScreen> createState() => _WarmupScreenState();
}

class _WarmupScreenState extends State<WarmupScreen> {
  String _selectedPlatform = 'instagram';
  String _selectedAccount = '';
  int _selectedDuration = 2;
  String _status = 'idle';
  String _metrics = '{}';
  bool _isRunning = false;
  Timer? _pollTimer;
  Timer? _backendPollTimer;
  String _lastRemoteStatus = '';
  bool _finishShown = false;
  bool _isLocalWarmup = false;
  bool _warmupSaved = false;
  int? _activeRemoteTaskId;
  Timer? _remotePollTimer;
  List<Map<String, dynamic>> _savedAccounts = [];

  String _lastAccountKey(String platform) {
    if (platform == 'tiktok') return 'last_tiktok_account';
    if (platform == 'youtube') return 'last_youtube_channel';
    return 'last_account';
  }

  @override
  void initState() {
    super.initState();
    _loadSavedAccount();
    _startRemotePolling();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadSavedAccounts();
  }

  Future<void> _loadSavedAccount() async {
    final prefs = await SharedPreferences.getInstance();
    final preferredPlatform = prefs.getString('selected_platform');
    var requestedPlatform = _selectedPlatform;
    if (!_isRunning &&
        (preferredPlatform == 'instagram' ||
            preferredPlatform == 'tiktok' ||
            preferredPlatform == 'youtube')) {
      requestedPlatform = preferredPlatform!;
      _selectedPlatform = requestedPlatform;
    }
    final saved = prefs.getString(_lastAccountKey(requestedPlatform)) ?? '';
    if (requestedPlatform != 'instagram') {
      final localAccounts = sortAccountsByUsername(
        await WarmupApi.getLocalAccounts(requestedPlatform),
      );
      if (mounted && _selectedPlatform == requestedPlatform) {
        final savedAccount = saved.replaceFirst(RegExp(r'^@'), '');
        final selected =
            localAccounts.any((a) => (a['username'] ?? '') == savedAccount)
            ? savedAccount
            : (localAccounts.isNotEmpty
                  ? (localAccounts.first['username'] ?? '').toString()
                  : '');
        setState(() {
          _selectedAccount = selected;
          _savedAccounts = localAccounts;
        });
      }
      return;
    }
    // Try backend first
    try {
      final backendAccounts = sortAccountsByUsername(
        await WarmupApi.getAccountsFromBackend(platform: requestedPlatform),
      );
      if (backendAccounts.isNotEmpty &&
          mounted &&
          _selectedPlatform == requestedPlatform) {
        setState(() {
          _savedAccounts = backendAccounts;
          // Keep selected account only if it still exists
          if (_selectedAccount.isNotEmpty &&
              !backendAccounts.any(
                (a) => (a['username'] ?? '') == _selectedAccount,
              )) {
            _selectedAccount = backendAccounts.first['username'] ?? '';
          } else if (_selectedAccount.isEmpty) {
            _selectedAccount = saved.replaceFirst(RegExp(r'^@'), '');
            if (!backendAccounts.any(
              (a) => (a['username'] ?? '') == _selectedAccount,
            )) {
              _selectedAccount = backendAccounts.first['username'] ?? '';
            }
          }
        });
        return;
      }
    } catch (_) {}
    // Fallback to local
    final accounts = sortAccountsByUsername(
      await WarmupApi.getLocalAccounts(requestedPlatform),
    );
    if (mounted && _selectedPlatform == requestedPlatform) {
      setState(() {
        _selectedAccount = saved.replaceFirst(RegExp(r'^@'), '');
        _savedAccounts = accounts;
      });
    }
  }

  Future<void> _loadSavedAccounts() async {
    final requestedPlatform = _selectedPlatform;
    if (requestedPlatform != 'instagram') {
      final localAccounts = sortAccountsByUsername(
        await WarmupApi.getLocalAccounts(requestedPlatform),
      );
      if (mounted && _selectedPlatform == requestedPlatform) {
        setState(() => _savedAccounts = localAccounts);
      }
      return;
    }
    // Try backend first
    try {
      final backendAccounts = sortAccountsByUsername(
        await WarmupApi.getAccountsFromBackend(platform: requestedPlatform),
      );
      if (backendAccounts.isNotEmpty &&
          mounted &&
          _selectedPlatform == requestedPlatform) {
        setState(() => _savedAccounts = backendAccounts);
        return;
      }
    } catch (_) {}
    // Fallback to local
    final accounts = sortAccountsByUsername(
      await WarmupApi.getLocalAccounts(requestedPlatform),
    );
    if (mounted && _selectedPlatform == requestedPlatform) {
      setState(() => _savedAccounts = accounts);
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _backendPollTimer?.cancel();
    _remotePollTimer?.cancel();
    super.dispose();
  }

  void _pollStatus() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
      final status = await WarmupApi.getStatus();
      final metrics = await WarmupApi.getMetrics();
      if (mounted) {
        setState(() {
          _status = status;
          _metrics = metrics;
          _isRunning =
              status == 'warming_up' ||
              status == 'opening_instagram' ||
              status == 'opening_tiktok' ||
              status == 'opening_youtube' ||
              status == 'navigating_to_reels' ||
              status == 'navigating_to_for_you' ||
              status == 'navigating_to_shorts' ||
              status == 'switching_account' ||
              status == 'paused';
        });

        if (status == 'finished' && !_finishShown) {
          _pollTimer?.cancel();
          _finishShown = true;
          // Read the final snapshot after the service publishes the finished
          // status. The native side writes metrics before that status now.
          final finishedMetrics = await WarmupApi.getMetrics();
          await WarmupApi.ackFinished();
          if (!_warmupSaved) {
            _warmupSaved = true;
            await _saveWarmupSession(finishedMetrics);
          }
          setState(() {
            _isRunning = false;
            _isLocalWarmup = false;
          });
          _showCompletionDialog(finishedMetrics);
          // Refresh accounts after warmup completes
          _loadSavedAccount();
        }
      }
    });
  }

  void _startRemotePolling() {
    _remotePollTimer?.cancel();
    String _prevRemoteStatus = 'idle';
    _remotePollTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (_isLocalWarmup) return;
      try {
        final status = await WarmupApi.getStatus();
        // Only react to transition: (warming_up/opening/navigating/switching) -> finished
        final wasRunning =
            _prevRemoteStatus == 'warming_up' ||
            _prevRemoteStatus == 'opening_instagram' ||
            _prevRemoteStatus == 'opening_tiktok' ||
            _prevRemoteStatus == 'opening_youtube' ||
            _prevRemoteStatus == 'navigating_to_reels' ||
            _prevRemoteStatus == 'navigating_to_for_you' ||
            _prevRemoteStatus == 'navigating_to_shorts' ||
            _prevRemoteStatus == 'switching_account';
        _prevRemoteStatus = status;
        if (status == 'finished' && wasRunning && !_finishShown) {
          _finishShown = true;
          WarmupApi.ackFinished();
          final metrics = await WarmupApi.getMetrics();
          if (!_warmupSaved) {
            _warmupSaved = true;
            // Save exactly once. _saveWarmupSession already creates the local
            // history row and updates the remote task when needed.
            await _saveWarmupSession(metrics);
          }
          if (mounted) {
            _showCompletionDialog(metrics);
            setState(() {
              _isRunning = false;
              _isLocalWarmup = false;
            });
          }
        }
      } catch (_) {}
    });
  }

  Future<void> _startWarmup() async {
    if (_selectedAccount.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Select an account first')));
      return;
    }

    final selectedMetadata = _savedAccounts.firstWhere(
      (account) =>
          (account['username'] ?? '').toString().replaceFirst(
            RegExp(r'^@'),
            '',
          ) ==
          _selectedAccount,
      orElse: () => <String, dynamic>{},
    );

    await WarmupApi.startOverlay();
    await WarmupApi.startWarmup(
      _selectedAccount,
      _selectedDuration,
      platform: _selectedPlatform,
      sourceAccountName: (selectedMetadata['source_account_name'] ?? '')
          .toString(),
      sourceAccountEmail: (selectedMetadata['source_account_email'] ?? '')
          .toString(),
      channelDisplayName: (selectedMetadata['display_name'] ?? '').toString(),
    );

    setState(() {
      _isRunning = true;
      _isLocalWarmup = true;
      _finishShown = false;
      _warmupSaved = false;
      _activeRemoteTaskId = null;
    });
    _pollStatus();
    _pollBackendCommands();
  }

  void _pollBackendCommands() {
    _backendPollTimer?.cancel();
    _backendPollTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (!_isRunning) {
        _backendPollTimer?.cancel();
        return;
      }
      try {
        final token = await AuthService.getValidAuthToken();
        final deviceId = await WarmupApi.getDeviceId();
        if (token == null || deviceId == 'unknown') return;

        final response = await http.get(
          Uri.parse('$API_BASE/tasks/active?device_id=$deviceId'),
          headers: {'Authorization': 'Bearer $token'},
        );
        if (response.statusCode != 200) return;

        final data = jsonDecode(response.body);
        if (!data['active']) return;

        final task = data['task'];
        _activeRemoteTaskId = task['id'];
        _isLocalWarmup = false;
        final remoteStatus = task['status'] as String? ?? '';

        // Only react to status changes
        if (remoteStatus == _lastRemoteStatus) return;
        _lastRemoteStatus = remoteStatus;

        if (remoteStatus == 'paused' && _status != 'paused') {
          await WarmupApi.pauseWarmup();
          if (mounted) setState(() => _status = 'paused');
        } else if (remoteStatus == 'running' && _status == 'paused') {
          await WarmupApi.resumeWarmup();
          if (mounted) setState(() => _status = 'warming_up');
        } else if (remoteStatus == 'cancelled') {
          await WarmupApi.stopWarmup();
          await WarmupApi.stopOverlay();
          _saveWarmupSession(_metrics, stoppedEarly: true);
          _backendPollTimer?.cancel();
          if (mounted)
            setState(() {
              _isRunning = false;
              _status = 'idle';
            });
        }
      } catch (e) {
        debugLog('Backend poll error: $e');
      }
    });
  }

  void _showCompletionDialog(String metrics) {
    final m = jsonDecode(metrics) as Map<String, dynamic>;
    final viewedLabel = (m['platform'] ?? _selectedPlatform) == 'youtube'
        ? 'Shorts'
        : 'Videos';
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: sfCard,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(
          children: [
            Icon(Icons.check_circle, color: sfGreen, size: 28),
            SizedBox(width: 12),
            Text(
              'Warmup complete',
              style: TextStyle(color: sfTextPrimary, fontSize: 20),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _MetricItem(
                  value: '${m['reels_viewed'] ?? m['videos_viewed'] ?? 0}',
                  label: viewedLabel,
                ),
                _MetricItem(value: '${m['likes'] ?? 0}', label: 'Likes'),
                _MetricItem(value: '${m['saves'] ?? 0}', label: 'Saves'),
              ],
            ),
          ],
        ),
        actions: [
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: () {
                Navigator.pop(ctx);
                setState(() {
                  _isRunning = false;
                  _status = 'idle';
                });
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: sfGreen,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: const Text(
                'Done',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _stopWarmup() async {
    final metricsBeforeStop = _metrics;
    await WarmupApi.stopWarmup();
    await WarmupApi.stopOverlay();
    if (_finishShown == false && _isRunning) {
      _saveWarmupSession(metricsBeforeStop, stoppedEarly: true);
    }
    setState(() {
      _isRunning = false;
      _isLocalWarmup = false;
    });
  }

  Future<void> _saveWarmupSession(
    String metricsJson, {
    bool stoppedEarly = false,
  }) async {
    try {
      final m = jsonDecode(metricsJson) as Map<String, dynamic>;
      final prefs = await SharedPreferences.getInstance();
      final platform = (m['platform'] ?? _selectedPlatform).toString();
      final deviceId = await WarmupApi.getDeviceId();
      final viewed = m['reels_viewed'] ?? m['videos_viewed'] ?? 0;
      final selectedAccountMetadata = _savedAccounts.firstWhere(
        (account) =>
            (account['username'] ?? '').toString().replaceFirst(
              RegExp(r'^@'),
              '',
            ) ==
            (m['account'] ?? _selectedAccount).toString().replaceFirst(
              RegExp(r'^@'),
              '',
            ),
        orElse: () => <String, dynamic>{},
      );

      final session = {
        'id': DateTime.now().millisecondsSinceEpoch.toString(),
        'account': (m['account'] ?? _selectedAccount).toString(),
        'platform': platform,
        'duration_minutes': m['duration_minutes'] ?? _selectedDuration,
        'reels_viewed': viewed,
        'videos_viewed': viewed,
        if (platform == 'youtube') 'shorts_viewed': viewed,
        'likes': m['likes'] ?? 0,
        'saves': m['saves'] ?? 0,
        if (platform == 'youtube') ...{
          'channel_display_name': selectedAccountMetadata['display_name'] ?? '',
          'source_account_name':
              selectedAccountMetadata['source_account_name'] ?? '',
          'source_account_email':
              selectedAccountMetadata['source_account_email'] ?? '',
        },
        'elapsed_sec': m['elapsed_sec'] ?? 0,
        'status': stoppedEarly ? 'stopped' : 'completed',
        'timestamp': DateTime.now().toIso8601String(),
        'synced': false,
      };

      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> decoded = jsonDecode(sessionsJson);
      final sessions = decoded
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      sessions.insert(0, session);
      if (sessions.length > 100) sessions.removeRange(100, sessions.length);

      await prefs.setString('warmup_sessions', jsonEncode(sessions));
      debugLog(
        'Session saved: ${session['account']} | ${session['reels_viewed']} reels | ${session['likes']} likes | ${session['saves']} saves',
      );

      final token = await AuthService.getValidAuthToken();
      if (token == null) return;

      if (!_isLocalWarmup && _activeRemoteTaskId != null) {
        await http.patch(
          Uri.parse('$API_BASE/tasks/runs/${_activeRemoteTaskId}'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({
            'status': 'completed',
            'result': {
              'reels_viewed': session['reels_viewed'],
              'platform': session['platform'],
              'likes': session['likes'],
              'saves': session['saves'],
              'elapsed_sec': session['elapsed_sec'],
              if (session['platform'] == 'youtube') ...{
                'channel_display_name': session['channel_display_name'],
                'source_account_name': session['source_account_name'],
                'source_account_email': session['source_account_email'],
              },
            },
          }),
        );
      } else {
        final response = await http.post(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({
            'device_id': deviceId,
            'account': session['account'],
            'platform': session['platform'],
            'duration_minutes': session['duration_minutes'],
            'reels_viewed': session['reels_viewed'],
            'likes': session['likes'],
            'saves': session['saves'],
            if (session['platform'] == 'youtube') ...{
              'channel_display_name': session['channel_display_name'],
              'source_account_name': session['source_account_name'],
              'source_account_email': session['source_account_email'],
            },
            'elapsed_sec': session['elapsed_sec'],
            'status': session['status'],
            'timestamp': session['timestamp'],
          }),
        );
        if (response.statusCode == 200 || response.statusCode == 201) {
          session['synced'] = true;
          await prefs.setString('warmup_sessions', jsonEncode(sessions));
        } else {
          debugLog(
            'Backend session save failed: ${response.statusCode} ${response.body}',
          );
        }
      }
    } catch (e) {
      debugLog('Error saving session: $e');
    }
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  Future<void> _selectPlatform(String platform) async {
    if (_selectedPlatform == platform || _isRunning) return;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('selected_platform', platform);
    setState(() {
      _selectedPlatform = platform;
      _selectedAccount = '';
      _savedAccounts = [];
    });
    await _loadSavedAccounts();
    await _loadSavedAccount();
  }

  void _showAccountPicker() async {
    // Always fetch fresh accounts from backend before showing picker
    try {
      final localAccounts = await WarmupApi.getLocalAccounts(_selectedPlatform);
      final backendAccounts = await WarmupApi.getAccountsFromBackend(
        platform: _selectedPlatform,
      );
      final accounts = _selectedPlatform == 'youtube'
          ? WarmupApi.mergeAccountMetadata(localAccounts, backendAccounts)
          : backendAccounts.isNotEmpty
          ? backendAccounts
          : localAccounts;
      final sortedAccounts = sortAccountsByUsername(accounts);
      if (sortedAccounts.isNotEmpty && mounted) {
        setState(() => _savedAccounts = sortedAccounts);
        // If selected account no longer exists, deselect
        if (_selectedAccount.isNotEmpty &&
            !sortedAccounts.any(
              (a) => (a['username'] ?? '') == _selectedAccount,
            )) {
          setState(() => _selectedAccount = '');
        }
      }
    } catch (_) {}
    if (_savedAccounts.isEmpty) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: sfCard,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 12),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: sfBorder,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 16),
            ..._savedAccounts.map((acc) {
              final username = (acc['username'] ?? '') as String;
              final picUrl = (acc['profile_pic_url'] ?? '') as String;
              final avatarUrl = resolveAvatarUrl(picUrl, API_BASE);
              final selected = username == _selectedAccount;
              return ListTile(
                leading: avatarUrl.isNotEmpty
                    ? CircleAvatar(
                        radius: 18,
                        backgroundImage: NetworkImage(avatarUrl),
                        backgroundColor: sfGreen.withValues(alpha: 0.2),
                      )
                    : CircleAvatar(
                        radius: 18,
                        backgroundColor: sfGreen.withValues(alpha: 0.2),
                        child: Icon(Icons.person, color: sfGreen, size: 18),
                      ),
                title: Text(
                  '@$username',
                  style: TextStyle(
                    color: selected ? sfGreen : sfTextPrimary,
                    fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                  ),
                ),
                trailing: PlatformLogo(
                  platform: _selectedPlatform,
                  size: 24,
                ),
                onTap: () {
                  setState(() => _selectedAccount = username);
                  SharedPreferences.getInstance().then(
                    (p) => p.setString(
                      _lastAccountKey(_selectedPlatform),
                      username,
                    ),
                  );
                  Navigator.pop(ctx);
                },
              );
            }),
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Platform',
              style: TextStyle(color: sfTextSecondary, fontSize: 14),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: ChoiceChip(
                    label: const Text('Instagram'),
                    selected: _selectedPlatform == 'instagram',
                    selectedColor: sfGreen,
                    backgroundColor: sfCard,
                    side: const BorderSide(color: sfBorder),
                    labelStyle: TextStyle(
                      color: _selectedPlatform == 'instagram'
                          ? Colors.black
                          : sfTextSecondary,
                    ),
                    onSelected: _isRunning
                        ? null
                        : (_) => _selectPlatform('instagram'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ChoiceChip(
                    label: const Text('TikTok'),
                    selected: _selectedPlatform == 'tiktok',
                    selectedColor: sfGreen,
                    backgroundColor: sfCard,
                    side: const BorderSide(color: sfBorder),
                    labelStyle: TextStyle(
                      color: _selectedPlatform == 'tiktok'
                          ? Colors.black
                          : sfTextSecondary,
                    ),
                    onSelected: _isRunning
                        ? null
                        : (_) => _selectPlatform('tiktok'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ChoiceChip(
                    label: const Text('YouTube'),
                    selected: _selectedPlatform == 'youtube',
                    selectedColor: sfGreen,
                    backgroundColor: sfCard,
                    side: const BorderSide(color: sfBorder),
                    labelStyle: TextStyle(
                      color: _selectedPlatform == 'youtube'
                          ? Colors.black
                          : sfTextSecondary,
                    ),
                    onSelected: _isRunning
                        ? null
                        : (_) => _selectPlatform('youtube'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              _selectedPlatform == 'tiktok'
                  ? 'TikTok Account'
                  : _selectedPlatform == 'youtube'
                  ? 'YouTube Channel'
                  : 'Instagram Account',
              style: TextStyle(color: sfTextSecondary, fontSize: 14),
            ),
            const SizedBox(height: 8),
            GestureDetector(
              onTap: () => _showAccountPicker(),
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: sfCard,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: sfBorder),
                ),
                child: Row(
                  children: [
                    _selectedAccount.isNotEmpty
                        ? Builder(
                            builder: (_) {
                              final acc = _savedAccounts
                                  .cast<Map<String, dynamic>>()
                                  .firstWhere(
                                    (a) =>
                                        (a['username'] ?? '') ==
                                        _selectedAccount,
                                    orElse: () => <String, dynamic>{},
                                  );
                              final picUrl =
                                  (acc['profile_pic_url'] ?? '') as String;
                              final avatarUrl = resolveAvatarUrl(
                                picUrl,
                                API_BASE,
                              );
                              return avatarUrl.isNotEmpty
                                  ? CircleAvatar(
                                      radius: 14,
                                      backgroundImage: NetworkImage(avatarUrl),
                                    )
                                  : const Icon(
                                      Icons.person,
                                      color: sfGreen,
                                      size: 20,
                                    );
                            },
                          )
                        : const Icon(Icons.person, color: sfGreen, size: 20),
                    const SizedBox(width: 12),
                    Text(
                      _selectedAccount.isEmpty
                          ? 'Select account...'
                          : '@$_selectedAccount',
                      style: TextStyle(
                        color: _selectedAccount.isEmpty
                            ? sfTextSecondary
                            : sfTextPrimary,
                        fontSize: 16,
                      ),
                    ),
                    const Spacer(),
                    PlatformLogo(platform: _selectedPlatform, size: 24),
                    const SizedBox(width: 8),
                    const Icon(Icons.chevron_right, color: sfTextSecondary),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            Text(
              'Duration',
              style: TextStyle(color: sfTextSecondary, fontSize: 14),
            ),
            const SizedBox(height: 8),
            Row(
              children: [2, 5, 10, 20]
                  .map(
                    (d) => Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: ChoiceChip(
                          label: Text('${d} min'),
                          selected: _selectedDuration == d,
                          selectedColor: sfGreen,
                          backgroundColor: sfCard,
                          side: const BorderSide(color: sfBorder),
                          labelStyle: TextStyle(
                            color: _selectedDuration == d
                                ? Colors.black
                                : sfTextSecondary,
                            fontWeight: FontWeight.bold,
                          ),
                          onSelected: _isRunning
                              ? null
                              : (_) => setState(() => _selectedDuration = d),
                        ),
                      ),
                    ),
                  )
                  .toList(),
            ),
            const SizedBox(height: 32),

            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _status == 'paused'
                    ? () async {
                        await WarmupApi.resumeWarmup();
                      }
                    : _isRunning
                    ? () async {
                        await WarmupApi.pauseWarmup();
                      }
                    : _startWarmup,
                style: FilledButton.styleFrom(
                  backgroundColor: _status == 'paused'
                      ? const Color(0xFF3b82f6)
                      : _isRunning
                      ? const Color(0xFFf97316)
                      : sfGreen,
                  foregroundColor: _status == 'paused' || _isRunning
                      ? Colors.white
                      : Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                  textStyle: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                icon: Icon(
                  _status == 'paused'
                      ? Icons.play_arrow
                      : _isRunning
                      ? Icons.pause
                      : Icons.play_arrow,
                ),
                label: Text(
                  _status == 'paused'
                      ? 'Resume Warmup'
                      : _isRunning
                      ? 'Pause Warmup'
                      : 'Start Warmup',
                ),
              ),
            ),
            if (_isRunning || _status == 'paused')
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: _stopWarmup,
                    icon: const Icon(Icons.stop_circle),
                    label: const Text('Stop Warmup'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.redAccent,
                      side: const BorderSide(color: Colors.redAccent),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _MetricItem({required String value, required String label}) {
    return Column(
      children: [
        Text(
          value,
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.bold,
            color: sfTextPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: sfTextSecondary),
        ),
      ],
    );
  }
}

// ─── Accounts Screen ─────────────────────────────────
class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key});

  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends State<AccountsScreen> {
  String _selectedPlatform = 'instagram';
  List<Map<String, dynamic>> _accounts = [];
  bool _loading = false;
  bool _cleaning = false;
  Timer? _avatarRefreshTimer;
  bool _avatarRefreshInFlight = false;

  @override
  void initState() {
    super.initState();
    _loadInitialPlatform();
    // The backend fills profile pictures asynchronously after a scan
    // finishes, so poll while any visible account is still missing its
    // avatar; ticks stop doing work once every avatar has resolved.
    _avatarRefreshTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      _refreshIfAvatarsMissing();
    });
  }

  @override
  void dispose() {
    _avatarRefreshTimer?.cancel();
    super.dispose();
  }

  // Re-fetches the accounts (same path as a platform switch) only when at
  // least one visible account has no profile picture yet.
  Future<void> _refreshIfAvatarsMissing() async {
    if (!mounted ||
        _loading ||
        _cleaning ||
        _avatarRefreshInFlight ||
        _accounts.isEmpty) {
      return;
    }
    final missingAvatar = _accounts.any(
      (acc) =>
          resolveAvatarUrl(acc['profile_pic_url'] as String?, API_BASE).isEmpty,
    );
    if (!missingAvatar) return;
    _avatarRefreshInFlight = true;
    try {
      await _loadSavedAccounts();
    } finally {
      _avatarRefreshInFlight = false;
    }
  }

  Future<void> _loadInitialPlatform() async {
    final prefs = await SharedPreferences.getInstance();
    final platform = prefs.getString('selected_platform') ?? 'instagram';
    if (mounted) {
      setState(
        () => _selectedPlatform = platform == 'tiktok'
            ? 'tiktok'
            : platform == 'youtube'
            ? 'youtube'
            : 'instagram',
      );
    }
    await _loadSavedAccounts();
  }

  Future<void> _loadSavedAccounts() async {
    // Try backend first, fallback to local
    try {
      final backendAccounts = sortAccountsByUsername(
        await WarmupApi.getAccountsFromBackend(platform: _selectedPlatform),
      );
      if (backendAccounts.isNotEmpty && mounted) {
        if (_accountsChanged(backendAccounts)) {
          setState(() => _accounts = backendAccounts);
        }
        return;
      }
    } catch (_) {}
    try {
      final localAccounts = sortAccountsByUsername(
        await WarmupApi.getLocalAccounts(_selectedPlatform),
      );
      if (mounted && _accountsChanged(localAccounts)) {
        setState(() => _accounts = localAccounts);
      }
    } catch (e) {
      debugLog('Error loading saved accounts: $e');
    }
  }

  // True when [next] differs from the accounts currently rendered, so the
  // periodic avatar refresh only rebuilds when the backend actually
  // changed something.
  bool _accountsChanged(List<Map<String, dynamic>> next) {
    if (next.length != _accounts.length) return true;
    try {
      return jsonEncode(next) != jsonEncode(_accounts);
    } catch (_) {
      return true;
    }
  }

  Future<void> _loadAccounts() async {
    setState(() => _loading = true);
    try {
      debugLog('SCAN: Starting account detection...');
      // Ensure device is registered before scanning
      await AuthService.registerDevice();
      final rawJson = await WarmupApi.detectAccounts(
        platform: _selectedPlatform,
      );
      debugLog('SCAN: detectAccounts returned: $rawJson');
      final List<dynamic> decoded = jsonDecode(rawJson);
      debugLog('SCAN: decoded count: ${decoded.length}');
      final detectedAccounts = decoded
          .map<Map<String, dynamic>>((a) {
            if (a is Map) {
              final account = Map<String, dynamic>.from(a);
              account['username'] = (account['username'] ?? '')
                  .toString()
                  .replaceFirst(RegExp(r'^@'), '')
                  .trim();
              return account;
            }
            return <String, dynamic>{
              'username': a.toString().replaceFirst(RegExp(r'^@'), '').trim(),
            };
          })
          .where((account) => (account['username'] ?? '').toString().isNotEmpty)
          .toList();
      final usernames = detectedAccounts
          .map((account) => account['username'].toString())
          .toList();
      debugLog('SCAN: usernames to sync: $usernames');

      List<Map<String, dynamic>> accounts;
      // Persist every platform through the unified endpoint. YouTube keeps
      // its richer channel metadata while Instagram and TikTok use the
      // normalized username records returned by the backend.
      await WarmupApi.syncAccountsToBackend(
        detectedAccounts,
        platform: _selectedPlatform,
      );
      final backendAccounts = await WarmupApi.getAccountsFromBackend(
        platform: _selectedPlatform,
      );
      debugLog('SCAN: backend returned ${backendAccounts.length} accounts');
      accounts = _selectedPlatform == 'youtube'
          ? WarmupApi.mergeAccountMetadata(detectedAccounts, backendAccounts)
          : backendAccounts.isNotEmpty
          ? backendAccounts
          : detectedAccounts;
      accounts = sortAccountsByUsername(accounts);
      if (mounted) setState(() => _accounts = accounts);

      // Also save locally as backup, namespaced by platform.
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        WarmupApi._accountCacheKey(_selectedPlatform),
        jsonEncode(accounts),
      );
    } catch (e) {
      debugLog('SCAN ERROR: $e');
      // On error, try loading from local cache or backend
      try {
        final backendAccounts = await WarmupApi.getAccountsFromBackend(
          platform: _selectedPlatform,
        );
        if (backendAccounts.isNotEmpty && mounted) {
          debugLog(
            'SCAN ERROR: loaded ${backendAccounts.length} accounts from backend as fallback',
          );
          setState(
            () => _accounts = sortAccountsByUsername(backendAccounts),
          );
        } else {
          final prefs = await SharedPreferences.getInstance();
          final cached = prefs.getString(
            WarmupApi._accountCacheKey(_selectedPlatform),
          );
          if (cached != null && mounted) {
            debugLog(
              'SCAN ERROR: loaded accounts from local cache as fallback',
            );
            setState(() {
              _accounts = sortAccountsByUsername(
                (jsonDecode(cached) as List).cast<Map<String, dynamic>>(),
              );
            });
          }
        }
      } catch (e2) {
        debugLog('SCAN ERROR fallback also failed: $e2');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _showCleanAccountsDialog() async {
    final selected = <String>{_selectedPlatform};
    final platforms = const [
      ('instagram', 'Instagram'),
      ('tiktok', 'TikTok'),
      ('youtube', 'YouTube'),
    ];
    final confirmed = await showDialog<List<String>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: sfCard,
          title: const Text('Clean accounts'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Choose the scanned platforms to remove from this phone. Scan history will be preserved.',
                style: TextStyle(color: sfTextSecondary),
              ),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => setDialogState(
                      () => selected.addAll(platforms.map((item) => item.$1)),
                    ),
                    child: const Text('Select all'),
                  ),
                  TextButton(
                    onPressed: () => setDialogState(selected.clear),
                    child: const Text('Clear selection'),
                  ),
                ],
              ),
              ...platforms.map(
                (platform) => CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: Text(platform.$2),
                  value: selected.contains(platform.$1),
                  activeColor: sfGreen,
                  onChanged: (checked) => setDialogState(() {
                    if (checked == true) {
                      selected.add(platform.$1);
                    } else {
                      selected.remove(platform.$1);
                    }
                  }),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: selected.isEmpty
                  ? null
                  : () => Navigator.pop(dialogContext, selected.toList()),
              style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
              child: const Text('Clean selected'),
            ),
          ],
        ),
      ),
    );
    if (confirmed == null || confirmed.isEmpty || !mounted) return;

    setState(() => _cleaning = true);
    try {
      final result = await WarmupApi.clearAccounts(platforms: confirmed);
      final prefs = await SharedPreferences.getInstance();
      for (final platform in confirmed) {
        await prefs.remove(WarmupApi._accountCacheKey(platform));
      }
      if (!mounted) return;
      if (confirmed.contains(_selectedPlatform)) {
        setState(() => _accounts = []);
      } else {
        await _loadSavedAccounts();
      }
      final total = result['total'] ?? 0;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Cleaned $total scanned account records')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Clean accounts failed: $e')));
    } finally {
      if (mounted) setState(() => _cleaning = false);
    }
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: RefreshIndicator(
        color: sfGreen,
        backgroundColor: sfCard,
        onRefresh: _loadSavedAccounts,
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              Text(
                'Accounts',
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: sfTextPrimary,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _selectedPlatform == 'tiktok'
                    ? 'Detected TikTok accounts'
                    : _selectedPlatform == 'youtube'
                    ? 'Detected YouTube channels'
                    : 'Detected Instagram accounts',
                style: const TextStyle(fontSize: 14, color: sfTextSecondary),
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: ChoiceChip(
                      label: const Text('Instagram'),
                      selected: _selectedPlatform == 'instagram',
                      selectedColor: sfGreen,
                      backgroundColor: sfCard,
                      side: const BorderSide(color: sfBorder),
                      labelStyle: TextStyle(
                        color: _selectedPlatform == 'instagram'
                            ? Colors.black
                            : sfTextSecondary,
                      ),
                      onSelected: _loading
                          ? null
                          : (_) async {
                              final prefs = await SharedPreferences.getInstance();
                              await prefs.setString(
                                'selected_platform',
                                'instagram',
                              );
                              setState(() {
                                _selectedPlatform = 'instagram';
                                _accounts = [];
                              });
                              await _loadSavedAccounts();
                            },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ChoiceChip(
                      label: const Text('YouTube'),
                      selected: _selectedPlatform == 'youtube',
                      selectedColor: sfGreen,
                      backgroundColor: sfCard,
                      side: const BorderSide(color: sfBorder),
                      labelStyle: TextStyle(
                        color: _selectedPlatform == 'youtube'
                            ? Colors.black
                            : sfTextSecondary,
                      ),
                      onSelected: _loading
                          ? null
                          : (_) async {
                              final prefs = await SharedPreferences.getInstance();
                              await prefs.setString(
                                'selected_platform',
                                'youtube',
                              );
                              setState(() {
                                _selectedPlatform = 'youtube';
                                _accounts = [];
                              });
                              await _loadSavedAccounts();
                            },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ChoiceChip(
                      label: const Text('TikTok'),
                      selected: _selectedPlatform == 'tiktok',
                      selectedColor: sfGreen,
                      backgroundColor: sfCard,
                      side: const BorderSide(color: sfBorder),
                      labelStyle: TextStyle(
                        color: _selectedPlatform == 'tiktok'
                            ? Colors.black
                            : sfTextSecondary,
                      ),
                      onSelected: _loading
                          ? null
                          : (_) async {
                              final prefs = await SharedPreferences.getInstance();
                              await prefs.setString(
                                'selected_platform',
                                'tiktok',
                              );
                              setState(() {
                                _selectedPlatform = 'tiktok';
                                _accounts = [];
                              });
                              await _loadSavedAccounts();
                            },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // Always-visible scan button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: _loading || _cleaning ? null : _loadAccounts,
                  icon: const Icon(Icons.search),
                  label: const Text('Scan accounts'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: sfGreen,
                    foregroundColor: Colors.black,
                  ),
                ),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _loading || _cleaning
                      ? null
                      : _showCleanAccountsDialog,
                  icon: const Icon(Icons.delete_sweep_outlined),
                  label: Text(
                    _cleaning ? 'Cleaning accounts…' : 'Clean accounts',
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.redAccent,
                    side: const BorderSide(color: Colors.redAccent),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (_loading)
                const Center(child: CircularProgressIndicator(color: sfGreen))
              else if (_accounts.isEmpty)
                Center(
                  child: Column(
                    children: [
                      Icon(
                        Icons.person_outline,
                        size: 48,
                        color: sfTextSecondary,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'No accounts found',
                        style: TextStyle(color: sfTextSecondary, fontSize: 16),
                      ),
                      const SizedBox(height: 16),
                      ElevatedButton.icon(
                        onPressed: _loadAccounts,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Scan'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: sfGreen,
                          foregroundColor: Colors.black,
                        ),
                      ),
                    ],
                  ),
                )
              else
                ..._accounts.map((acc) {
                  final username = acc['username'] ?? acc.toString();
                  final picUrl = acc['profile_pic_url'] ?? '';
                  final avatarUrl = resolveAvatarUrl(
                    picUrl as String?,
                    API_BASE,
                  );
                  return Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: sfCard,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: sfBorder),
                    ),
                    child: Row(
                      children: [
                        avatarUrl.isNotEmpty
                            ? CircleAvatar(
                                radius: 20,
                                backgroundColor: sfGreen.withValues(alpha: 0.2),
                                backgroundImage: NetworkImage(avatarUrl),
                              )
                            : CircleAvatar(
                                radius: 20,
                                backgroundColor: sfGreen.withValues(alpha: 0.2),
                                child: Icon(Icons.person, color: sfGreen),
                              ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            '@$username',
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: sfTextPrimary,
                            ),
                          ),
                        ),
                        PlatformLogo(platform: _selectedPlatform, size: 24),
                      ],
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
  }
}

// ─── History Screen ──────────────────────────────────
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  List<Map<String, dynamic>> _sessions = [];
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // The screen is recreated by the bottom navigation when it becomes
    // visible; initState performs the single initial load. Calling this again
    // caused concurrent requests and made the duplicate-history bug harder to
    // reason about.
  }

  void reload() {
    _loadSessions();
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  String _sessionAccount(Map<String, dynamic> session) {
    return (session['account'] ?? session['username'] ?? '')
        .toString()
        .replaceFirst(RegExp(r'^@'), '')
        .trim()
        .toLowerCase();
  }

  String _sessionTimestamp(Map<String, dynamic> session) {
    return (session['timestamp'] ?? session['created_at'] ?? '').toString();
  }

  String _sessionPlatform(Map<String, dynamic> session) {
    final platform = (session['platform'] ?? '')
        .toString()
        .trim()
        .toLowerCase();
    final taskType = (session['task_type'] ?? '')
        .toString()
        .trim()
        .toLowerCase();

    // Local YouTube rows carry shorts_viewed. Keep that signal authoritative
    // when an older remote row was returned with the default Instagram label.
    if (platform == 'youtube' ||
        platform == 'shorts' ||
        taskType == 'warmup_youtube' ||
        session.containsKey('shorts_viewed')) {
      return 'youtube';
    }
    if (platform == 'tiktok') return 'tiktok';
    return platform.isEmpty ? 'instagram' : platform;
  }

  bool _isYouTubeMirror(Map<String, dynamic> a, Map<String, dynamic> b) {
    if (_sessionPlatform(a) == _sessionPlatform(b)) return false;
    final oneIsYouTube =
        _sessionPlatform(a) == 'youtube' || _sessionPlatform(b) == 'youtube';
    final hasShortsMarker =
        a.containsKey('shorts_viewed') || b.containsKey('shorts_viewed');
    return oneIsYouTube && hasShortsMarker;
  }

  int _sessionInt(Map<String, dynamic> session, String key) {
    final value = session[key];
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  bool _sameSession(Map<String, dynamic> a, Map<String, dynamic> b) {
    if (_sessionAccount(a) != _sessionAccount(b)) return false;
    if (_sessionInt(a, 'duration_minutes') !=
        _sessionInt(b, 'duration_minutes'))
      return false;
    if (_sessionInt(a, 'reels_viewed') != _sessionInt(b, 'reels_viewed'))
      return false;
    if (_sessionInt(a, 'likes') != _sessionInt(b, 'likes')) return false;
    if (_sessionInt(a, 'saves') != _sessionInt(b, 'saves')) return false;
    if (_sessionPlatform(a) != _sessionPlatform(b) && !_isYouTubeMirror(a, b))
      return false;

    final aTime = DateTime.tryParse(_sessionTimestamp(a));
    final bTime = DateTime.tryParse(_sessionTimestamp(b));
    if (aTime == null || bTime == null)
      return _sessionTimestamp(a) == _sessionTimestamp(b);
    return aTime.difference(bTime).inSeconds.abs() <= 10;
  }

  Future<void> _loadSessions() async {
    if (mounted) setState(() => _loading = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> decoded = jsonDecode(sessionsJson);

      List<Map<String, dynamic>> local = decoded
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();

      // Fetch backend sessions
      List<Map<String, dynamic>> backend = [];
      bool backendLoaded = false;
      final token = await AuthService.getValidAuthToken();
      if (token != null) {
        final res = await http.get(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {'Authorization': 'Bearer $token'},
        );
        if (res.statusCode == 200) {
          final data = jsonDecode(res.body);
          backend = (data['sessions'] as List)
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
          backendLoaded = true;
        }
      }

      // Merge local + backend as one logical history. Local rows are created
      // first for offline safety and then uploaded; their IDs are different
      // from backend IDs, so deduping by id alone always showed both copies.
      // Match by account, metrics and a small timestamp window instead.
      final uniqueBackend = <Map<String, dynamic>>[];
      for (final session in backend) {
        if (!uniqueBackend.any((existing) => _sameSession(existing, session))) {
          uniqueBackend.add(session);
        }
      }

      final Map<String, Map<String, dynamic>> map = {};
      for (var i = 0; i < uniqueBackend.length; i++) {
        final s = uniqueBackend[i];
        final key = (s['id'] ?? s['timestamp'] ?? 'backend_$i').toString();
        if (key.isEmpty) continue;
        map['backend:$key'] = s;
      }

      var localChanged = false;
      final uniqueLocal = <Map<String, dynamic>>[];
      for (final session in local) {
        if (uniqueLocal.any((existing) => _sameSession(existing, session)))
          continue;
        uniqueLocal.add(session);

        Map<String, dynamic>? remoteMatch;
        if (backendLoaded) {
          for (final remote in uniqueBackend) {
            if (_sameSession(remote, session)) {
              remoteMatch = remote;
              break;
            }
          }
        }

        if (remoteMatch != null) {
          // If an older API response mislabeled the remote copy as Instagram,
          // keep the local YouTube metadata so the single visible row remains
          // a Shorts session instead of becoming a second "Videos" row.
          if (_sessionPlatform(session) == 'youtube' &&
              _sessionPlatform(remoteMatch) != 'youtube') {
            final remoteKey =
                (remoteMatch['id'] ?? remoteMatch['timestamp'] ?? '')
                    .toString();
            if (remoteKey.isNotEmpty) {
              map['backend:$remoteKey'] = {
                ...remoteMatch,
                'platform': 'youtube',
                if (session['shorts_viewed'] != null)
                  'shorts_viewed': session['shorts_viewed'],
              };
            }
          }
          if (session['synced'] != true) {
            session['synced'] = true;
            localChanged = true;
          }
          continue;
        }

        final key = (session['id'] ?? session['timestamp'] ?? '').toString();
        if (key.isNotEmpty) map['local:$key'] = session;
      }

      if (localChanged) {
        await prefs.setString('warmup_sessions', jsonEncode(local));
      }

      final merged = map.values.toList();
      merged.sort(
        (a, b) => (b['timestamp'] ?? '').compareTo(a['timestamp'] ?? ''),
      );

      if (mounted) setState(() => _sessions = merged);
    } catch (e) {
      debugLog('Error loading sessions: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _syncToBackend() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = await AuthService.getValidAuthToken();
      if (token == null) return;
      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> sessions = jsonDecode(sessionsJson);
      for (final s in sessions) {
        if (s['synced'] == true) continue;
        final res = await http.post(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({
            'account': s['account'],
            'platform': s['platform'] ?? 'instagram',
            'duration_minutes': s['duration_minutes'],
            'reels_viewed': s['reels_viewed'] ?? 0,
            'likes': s['likes'] ?? 0,
            'saves': s['saves'] ?? 0,
            'elapsed_sec': s['elapsed_sec'] ?? 0,
            'status': s['status'] ?? 'completed',
            'timestamp': s['timestamp'],
          }),
        );
        if (res.statusCode == 200 || res.statusCode == 201) {
          s['synced'] = true;
          await prefs.setString('warmup_sessions', jsonEncode(sessions));
          debugLog('Session synced to backend');
        } else {
          debugLog('Sync failed: ${res.statusCode} ${res.body}');
        }
      }
      _loadSessions();
    } catch (e) {
      debugLog('Sync error (will retry later): $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: RefreshIndicator(
        color: sfGreen,
        onRefresh: () async {
          await _loadSessions();
          await _syncToBackend();
        },
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'History',
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                      color: sfTextPrimary,
                    ),
                  ),
                  IconButton(
                    onPressed: _syncToBackend,
                    icon: Icon(
                      Icons.cloud_upload_outlined,
                      color: sfTextSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${_sessions.length} sesiones',
                style: const TextStyle(fontSize: 14, color: sfTextSecondary),
              ),
              const SizedBox(height: 20),
              if (_loading)
                const Center(child: CircularProgressIndicator(color: sfGreen))
              else if (_sessions.isEmpty)
                Center(
                  child: Column(
                    children: [
                      Icon(Icons.history, size: 48, color: sfTextSecondary),
                      const SizedBox(height: 12),
                      Text(
                        'No sessions yet',
                        style: TextStyle(color: sfTextSecondary, fontSize: 16),
                      ),
                    ],
                  ),
                )
              else
                ..._sessions.map(
                  (s) => Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: sfCard,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: sfBorder),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              '@${s['account'] ?? '?'}',
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                                color: sfGreen,
                              ),
                            ),
                            Text(
                              _formatTime(s['timestamp']),
                              style: const TextStyle(
                                fontSize: 12,
                                color: sfTextSecondary,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceAround,
                          children: [
                            _metric(
                              '${s['reels_viewed'] ?? 0}',
                              _sessionPlatform(s) == 'youtube'
                                  ? 'Shorts'
                                  : 'Videos',
                              sfGreen,
                            ),
                            _metric(
                              '${s['likes'] ?? 0}',
                              'Likes',
                              const Color(0xFFf472b6),
                            ),
                            _metric(
                              '${_sessionInt(s, 'saves')}',
                              'Saves',
                              const Color(0xFFfbbf24),
                            ),
                            _metric(
                              '${s['duration_minutes'] ?? '?'}min',
                              'Duration',
                              sfTextSecondary,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _metric(String value, String label, Color color) {
    return Column(
      children: [
        Text(
          value,
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: sfTextSecondary),
        ),
      ],
    );
  }

  String _formatTime(String? iso) {
    if (iso == null) return '';
    try {
      final dt = DateTime.parse(iso).toLocal();
      return '${dt.day}/${dt.month} ${dt.hour}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return '';
    }
  }
}
