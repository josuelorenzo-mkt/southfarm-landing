import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;

const String apiUrl = 'https://api.southfarm.tech/api';
const String API_BASE = 'https://api.southfarm.tech/api';
const Color sfGreen = Color(0xFF34d399);
const Color sfBg = Color(0xFF0b0f0b);
const Color sfCard = Color(0xFF141a14);
const Color sfBorder = Color(0xFF1f2a1f);
const Color sfTextPrimary = Color(0xFFe8ede8);
const Color sfTextSecondary = Color(0xFF6b7f6b);
const Color sfAmber = Color(0xFFf59e0b);

void main() {
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
          border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(12))),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(12)), borderSide: BorderSide(color: sfBorder)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(12)), borderSide: BorderSide(color: sfGreen)),
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

// ─── SouthFarm Logo Widget ───
class SouthFarmLogo extends StatelessWidget {
  final double fontSize;
  final IconData leafIcon;
  const SouthFarmLogo({super.key, this.fontSize = 24, this.leafIcon = Icons.eco});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(leafIcon, color: sfGreen, size: fontSize * 0.9),
        const SizedBox(width: 8),
        RichText(
          text: TextSpan(
            style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.bold, color: sfTextPrimary),
            children: const [
              TextSpan(text: 'South', style: TextStyle(color: sfGreen)),
              TextSpan(text: 'Farm', style: TextStyle(color: sfTextPrimary)),
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

  static Future<bool> startWarmup(String username, int duration) async {
    final result = await _channel.invokeMethod<bool>('startWarmup', {'username': username, 'duration': duration});
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
    try { await _channel.invokeMethod<bool>('ackFinished'); } catch (_) {}
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
    final result = await _channel.invokeMethod<bool>('openAccessibilitySettings');
    return result ?? false;
  }

  static Future<bool> isOverlayPermissionGranted() async {
    final result = await _channel.invokeMethod<bool>('isOverlayPermissionGranted');
    return result ?? false;
  }

  static Future<bool> requestOverlayPermission() async {
    final result = await _channel.invokeMethod<bool>('requestOverlayPermission');
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

  static Future<String> detectAccounts() async {
    final result = await _channel.invokeMethod<String>('detectAccounts');
    return result ?? '[]';
  }

  // ─── Backend API helpers ───
  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('auth_token');
  }

  static Future<String> getDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('device_id') ?? prefs.getString('stable_device_id') ?? 'unknown';
  }

  static Future<void> syncAccountsToBackend(List<String> usernames) async {
    final token = await getToken();
    final deviceId = await getDeviceId();
    if (token == null) { print('[SouthFarm] syncAccounts: no token'); return; }
    try {
      final res = await http.post(
        Uri.parse('$API_BASE/ig-accounts'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
        body: jsonEncode({'device_id': deviceId, 'usernames': usernames}),
      );
      if (res.statusCode != 201) {
        print('[SouthFarm] syncAccounts FAILED: ${res.statusCode} ${res.body}');
      } else {
        print('[SouthFarm] syncAccounts OK: ${usernames.length} accounts synced for device $deviceId');
      }
    } catch (e) {
      print('[SouthFarm] syncAccounts ERROR: $e');
    }
  }

  static Future<List<Map<String, dynamic>>> getAccountsFromBackend() async {
    final token = await getToken();
    final deviceId = await getDeviceId();
    if (token == null) return [];
    try {
      final res = await http.get(
        Uri.parse('$API_BASE/ig-accounts?device_id=$deviceId'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final accounts = (data['accounts'] as List).cast<Map<String, dynamic>>();
        print('[SouthFarm] getAccounts: ${accounts.length} accounts for device $deviceId');
        return accounts;
      } else {
        print('[SouthFarm] getAccounts FAILED: ${res.statusCode}');
      }
    } catch (e) {
      print('[SouthFarm] getAccounts ERROR: $e');
    }
    return [];
  }
}

// ─── Splash ───
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _fadeAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500));
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
    final token = prefs.getString('auth_token');
    if (!mounted) return;

    if (!done) {
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const OnboardingScreen()));
    } else if (token == null) {
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const AuthScreen()));
    } else {
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const MainScreen()));
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
              const Text('Mobile automation', style: TextStyle(color: sfTextSecondary, fontSize: 16)),
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
    _OBStep(Icons.local_florist, 'Welcome to SouthFarm', 'Automate tasks on your phone.\nWarmups, posts, and more.'),
    _OBStep(Icons.security, 'Enable Accessibility', 'SouthFarm needs accessibility permission\nto simulate screen taps.'),
    _OBStep(Icons.layers, 'Enable Overlay', 'You will see a protective layer when\nSouthFarm is working.'),
    _OBStep(Icons.check_circle, 'All set!', 'Set up your tasks and get started.\nsouthfarm.tech'),
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
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const MainScreen()));
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
                width: 100, height: 100,
                decoration: BoxDecoration(
                  color: sfGreen.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(color: sfGreen.withValues(alpha: 0.2)),
                ),
                child: Icon(s.icon, size: 48, color: sfGreen),
              ),
              const SizedBox(height: 32),
              Text(s.title, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: sfTextPrimary)),
              const SizedBox(height: 12),
              Text(s.desc, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, color: sfTextSecondary)),
              if (_step == 1 || _step == 2) ...[
                const SizedBox(height: 24),
                Text(
                  _step == 1 ? 'Tap the button and enable SouthFarm in Accessibility' : 'Tap the button and allow SouthFarm over other apps',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: sfAmber, fontSize: 14),
                ),
              ],
              const Spacer(flex: 3),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(_steps.length, (i) => Container(
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  width: i == _step ? 24 : 8, height: 8,
                  decoration: BoxDecoration(
                    color: i == _step ? sfGreen : sfBorder,
                    borderRadius: BorderRadius.circular(4),
                  ),
                )),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _next,
                  style: FilledButton.styleFrom(
                    backgroundColor: sfGreen, foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  child: Text(_step < _steps.length - 1 ? 'Enable' : 'Get Started'),
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
  final IconData icon; final String title; final String desc;
  const _OBStep(this.icon, this.title, this.desc);
}

// ─── Auth Service ───
class AuthService {
  static Future<bool> register(String email, String password, String name) async {
    try {
      final res = await http.post(
        Uri.parse('$API_BASE/auth/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password, 'name': name}),
      );
      if (res.statusCode == 201) {
        final data = jsonDecode(res.body);
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('auth_token', data['token']);
        await prefs.setString('user_email', email);
        await prefs.setString('user_name', data['user']['name']);
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
        final data = jsonDecode(res.body);
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('auth_token', data['token']);
        await prefs.setString('user_email', email);
        await prefs.setString('user_name', data['user']['name']);
        return true;
      }
      return false;
    } catch (e) {
      print('[Auth] Login error: $e');
      return false;
    }
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('auth_token');
    await prefs.remove('user_email');
    await prefs.remove('user_name');
  }

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('auth_token');
  }

  static Future<void> registerDevice() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('auth_token');
      if (token == null) return;

      final existingId = prefs.getString('device_id');
      final deviceInfo = await _getDeviceInfo();

      final res = await http.post(
        Uri.parse('$API_BASE/devices/register'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
        body: jsonEncode({
          'device_id': deviceInfo['device_id']!,
          'device_name': deviceInfo['device_name'],
          'android_version': deviceInfo['android_version'],
        }),
      );

      if (res.statusCode == 201) {
        await prefs.setString('device_id', deviceInfo['device_id']!);
        print('[Device] Registered: ${deviceInfo['device_name']}');
      } else if (res.statusCode == 200 || existingId != null) {
        await prefs.setString('device_id', deviceInfo['device_id']!);
      } else {
        print('[Device] Register failed: ${res.statusCode} ${res.body}');
      }
    } catch (e) {
      print('[Device] Register error: $e');
    }
  }

  static Future<Map<String, String>> _getDeviceInfo() async {
    try {
      final info = await MethodChannel('com.example.southfarm_app/warmup').invokeMethod<Map>('getDeviceInfo');
      if (info != null) {
        return Map<String, String>.from(info);
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
    return {'device_id': deviceId, 'device_name': 'Unknown', 'android_version': '?'};
  }

  static Future<Map<String, dynamic>?> checkPendingTasks() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('auth_token');
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
    setState(() { _loading = true; _error = null; });
    final email = _emailCtrl.text.trim();
    final pass = _passCtrl.text;
    final name = _nameCtrl.text.trim();

    if (email.isEmpty || pass.isEmpty || (!_isLogin && name.isEmpty)) {
      setState(() { _error = 'Please fill in all fields'; _loading = false; });
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
      AuthService.registerDevice();
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const MainScreen()));
    } else {
      setState(() { _error = _isLogin ? 'Incorrect email or password' : 'Error creating account. Already exists?'; _loading = false; });
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
                decoration: BoxDecoration(color: sfCard, borderRadius: BorderRadius.circular(12)),
                child: Row(
                  children: [
                    Expanded(child: _tabBtn('Log In', _isLogin, () => setState(() => _isLogin = true))),
                    Expanded(child: _tabBtn('Sign Up', !_isLogin, () => setState(() => _isLogin = false))),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              if (!_isLogin) ...[
                TextField(controller: _nameCtrl, style: const TextStyle(color: sfTextPrimary), decoration: const InputDecoration(hintText: 'Name', hintStyle: TextStyle(color: sfTextSecondary))),
                const SizedBox(height: 12),
              ],

              TextField(controller: _emailCtrl, keyboardType: TextInputType.emailAddress, style: const TextStyle(color: sfTextPrimary), decoration: const InputDecoration(hintText: 'Email', hintStyle: TextStyle(color: sfTextSecondary))),
              const SizedBox(height: 12),

              TextField(controller: _passCtrl, obscureText: true, style: const TextStyle(color: sfTextPrimary), decoration: const InputDecoration(hintText: 'Password', hintStyle: TextStyle(color: sfTextSecondary))),
              const SizedBox(height: 24),

              if (_error != null) ...[
                Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
                const SizedBox(height: 12),
              ],

              SizedBox(
                width: double.infinity,
                height: 50,
                child: ElevatedButton(
                  onPressed: _loading ? null : _submit,
                  style: ElevatedButton.styleFrom(backgroundColor: sfGreen, foregroundColor: Colors.black, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                  child: _loading
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                      : Text(_isLogin ? 'Log In' : 'Sign Up', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
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
        decoration: BoxDecoration(color: active ? sfGreen : Colors.transparent, borderRadius: BorderRadius.circular(8)),
        child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: active ? Colors.black : sfTextSecondary, fontWeight: FontWeight.w600, fontSize: 14)),
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

class _MainScreenState extends State<MainScreen> {
  int _currentIndex = 0;
  final _historyKey = GlobalKey<State<HistoryScreen>>();
  String _userName = '';

  @override
  void initState() {
    super.initState();
    _loadUser();
  }

  Future<void> _loadUser() async {
    final prefs = await SharedPreferences.getInstance();
    if (mounted) setState(() => _userName = prefs.getString('user_name') ?? '');
  }

  void _showLogoutDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: sfCard,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Log out', style: TextStyle(color: sfTextPrimary, fontSize: 18)),
        content: Text('Do you want to log out, $_userName?', style: const TextStyle(color: sfTextSecondary)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel', style: TextStyle(color: sfTextSecondary))),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await AuthService.logout();
              if (mounted) {
                Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const AuthScreen()));
              }
            },
            child: const Text('Log out', style: TextStyle(color: Colors.redAccent)),
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
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(color: sfCard, borderRadius: BorderRadius.circular(20), border: Border.all(color: sfBorder)),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircleAvatar(radius: 12, backgroundColor: sfGreen.withValues(alpha: 0.2), child: Icon(Icons.person, size: 16, color: sfGreen)),
                        const SizedBox(width: 8),
                        Text(_userName, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: sfTextPrimary)),
                        const SizedBox(width: 4),
                        Icon(Icons.chevron_right, size: 16, color: sfTextSecondary),
                      ],
                    ),
                  ),
                ),
              ],
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
          BottomNavigationBarItem(icon: Icon(Icons.play_circle), label: 'Warmup'),
          BottomNavigationBarItem(icon: Icon(Icons.person_outline), label: 'Accounts'),
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
    final saved = prefs.getString('last_account') ?? '';
    // Try backend first
    try {
      final backendAccounts = await WarmupApi.getAccountsFromBackend();
      if (backendAccounts.isNotEmpty && mounted) {
        setState(() {
          _savedAccounts = backendAccounts;
          // Keep selected account only if it still exists
          if (_selectedAccount.isNotEmpty && !backendAccounts.any((a) => (a['username'] ?? '') == _selectedAccount)) {
            _selectedAccount = backendAccounts.first['username'] ?? '';
          } else if (_selectedAccount.isEmpty) {
            _selectedAccount = saved.replaceFirst(RegExp(r'^@'), '');
            if (!backendAccounts.any((a) => (a['username'] ?? '') == _selectedAccount)) {
              _selectedAccount = backendAccounts.first['username'] ?? '';
            }
          }
        });
        return;
      }
    } catch (_) {}
    // Fallback to local
    final accountsJson = prefs.getString('detected_accounts') ?? '[]';
    final decoded = jsonDecode(accountsJson) as List;
    final accounts = decoded.map((a) {
      if (a is Map) return {'username': (a['username'] ?? '').toString().replaceFirst(RegExp(r'^@'), ''), 'profile_pic_url': a['profile_pic_url'] ?? ''};
      return {'username': a.toString().replaceFirst(RegExp(r'^@'), ''), 'profile_pic_url': ''};
    }).where((a) => (a['username'] as String).isNotEmpty).toList();
    if (mounted) {
      setState(() {
        _selectedAccount = saved.replaceFirst(RegExp(r'^@'), '');
        _savedAccounts = accounts;
      });
    }
  }

  Future<void> _loadSavedAccounts() async {
    // Try backend first
    try {
      final backendAccounts = await WarmupApi.getAccountsFromBackend();
      if (backendAccounts.isNotEmpty && mounted) {
        setState(() => _savedAccounts = backendAccounts);
        return;
      }
    } catch (_) {}
    // Fallback to local
    final prefs = await SharedPreferences.getInstance();
    final accountsJson = prefs.getString('detected_accounts') ?? '[]';
    final decoded = jsonDecode(accountsJson) as List;
    final accounts = decoded.map((a) {
      if (a is Map) return {'username': (a['username'] ?? '').toString().replaceFirst(RegExp(r'^@'), ''), 'profile_pic_url': a['profile_pic_url'] ?? ''};
      return {'username': a.toString().replaceFirst(RegExp(r'^@'), ''), 'profile_pic_url': ''};
    }).where((a) => (a['username'] as String).isNotEmpty).toList();
    if (mounted) {
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
          _isRunning = status == 'warming_up' || status == 'opening_instagram' || status == 'navigating_to_reels' || status == 'switching_account' || status == 'paused';
        });

        if (status == 'finished' && !_finishShown) {
          _pollTimer?.cancel();
          _finishShown = true;
          WarmupApi.ackFinished();
          if (!_warmupSaved) {
            _warmupSaved = true;
            _saveWarmupSession(metrics);
          }
          setState(() { _isRunning = false; _isLocalWarmup = false; });
          _showCompletionDialog(metrics);
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
        final wasRunning = _prevRemoteStatus == 'warming_up' || _prevRemoteStatus == 'opening_instagram' || _prevRemoteStatus == 'navigating_to_reels' || _prevRemoteStatus == 'switching_account';
        _prevRemoteStatus = status;
        if (status == 'finished' && wasRunning && !_finishShown) {
          _finishShown = true;
          WarmupApi.ackFinished();
          final metrics = await WarmupApi.getMetrics();
          final prefs = await SharedPreferences.getInstance();
          final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
          final sessions = (jsonDecode(sessionsJson) as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
          final parsed = jsonDecode(metrics) as Map<String, dynamic>;
          final session = {
            'id': 'remote_${DateTime.now().millisecondsSinceEpoch}',
            'account': parsed['account'] ?? 'remote',
            'duration_minutes': parsed['duration_minutes'] ?? 2,
            'reels_viewed': parsed['reels_viewed'] ?? 0,
            'likes': parsed['likes'] ?? 0,
            'saves': parsed['saves'] ?? 0,
            'elapsed_sec': parsed['elapsed_sec'] ?? 0,
            'timestamp': DateTime.now().toIso8601String(),
            'synced': false,
          };
          sessions.insert(0, session);
          await prefs.setString('warmup_sessions', jsonEncode(sessions));
          if (!_warmupSaved) {
            _warmupSaved = true;
            await _saveWarmupSession(metrics);
          }
          if (mounted) {
            _showCompletionDialog(metrics);
            setState(() { _isRunning = false; _isLocalWarmup = false; });
          }
        }
      } catch (_) {}
    });
  }

  Future<void> _startWarmup() async {
    if (_selectedAccount.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select an account first')),
      );
      return;
    }

    await WarmupApi.startOverlay();
    await WarmupApi.startWarmup(_selectedAccount, _selectedDuration);

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
      if (!_isRunning) { _backendPollTimer?.cancel(); return; }
      try {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString('auth_token');
        final deviceId = prefs.getString('stable_device_id');
        if (token == null || deviceId == null) return;

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
          if (mounted) setState(() { _isRunning = false; _status = 'idle'; });
        }
      } catch (e) {
        debugLog('Backend poll error: $e');
      }
    });
  }

  void _showCompletionDialog(String metrics) {
    final m = jsonDecode(metrics) as Map<String, dynamic>;
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
            Text('Warmup complete', style: TextStyle(color: sfTextPrimary, fontSize: 20)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _MetricItem(value: '${m['reels_viewed'] ?? 0}', label: 'Reels'),
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
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: const Text('Done', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _stopWarmup() async {
    await WarmupApi.stopWarmup();
    await WarmupApi.stopOverlay();
    if (_finishShown == false && _isRunning) {
      _saveWarmupSession(_metrics, stoppedEarly: true);
    }
    setState(() { _isRunning = false; _isLocalWarmup = false; });
  }

  Future<void> _saveWarmupSession(String metricsJson, {bool stoppedEarly = false}) async {
    try {
      final m = jsonDecode(metricsJson) as Map<String, dynamic>;
      final prefs = await SharedPreferences.getInstance();

      final session = {
        'id': DateTime.now().millisecondsSinceEpoch.toString(),
        'account': _selectedAccount,
        'duration_minutes': _selectedDuration,
        'reels_viewed': m['reels_viewed'] ?? 0,
        'likes': m['likes'] ?? 0,
        'saves': m['saves'] ?? 0,
        'elapsed_sec': m['elapsed_sec'] ?? 0,
        'status': stoppedEarly ? 'stopped' : 'completed',
        'timestamp': DateTime.now().toIso8601String(),
        'synced': false,
      };

      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> decoded = jsonDecode(sessionsJson);
      final sessions = decoded.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      sessions.insert(0, session);
      if (sessions.length > 100) sessions.removeRange(100, sessions.length);

      await prefs.setString('warmup_sessions', jsonEncode(sessions));
      debugLog('Session saved: ${session['account']} | ${session['reels_viewed']} reels | ${session['likes']} likes');

      final token = prefs.getString('auth_token');
      if (token == null) return;

      if (!_isLocalWarmup && _activeRemoteTaskId != null) {
        await http.patch(
          Uri.parse('$API_BASE/tasks/runs/${_activeRemoteTaskId}'),
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
          body: jsonEncode({
            'status': 'completed',
            'result': {
              'reels_viewed': session['reels_viewed'],
              'likes': session['likes'],
              'saves': session['saves'],
              'elapsed_sec': session['elapsed_sec'],
            }
          }),
        );
      } else {
        await http.post(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
          body: jsonEncode({
            'account': session['account'],
            'duration_minutes': session['duration_minutes'],
            'reels_viewed': session['reels_viewed'],
            'likes': session['likes'],
            'saves': session['saves'],
            'elapsed_sec': session['elapsed_sec'],
            'status': session['status'],
            'timestamp': session['timestamp'],
          }),
        );
      }
    } catch (e) {
      debugLog('Error saving session: $e');
    }
  }

  Future<void> _syncSessionToBackend(Map<String, dynamic> session, List<Map<String, dynamic>> sessions, SharedPreferences prefs) async {
    try {
      final token = prefs.getString('auth_token');
      if (token == null) return;

      final res = await http.post(
        Uri.parse('$API_BASE/warmup-sessions'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
        body: jsonEncode({
          'account': session['account'],
          'duration_minutes': session['duration_minutes'],
          'reels_viewed': session['reels_viewed'],
          'likes': session['likes'],
          'saves': session['saves'],
          'elapsed_sec': session['elapsed_sec'],
          'status': session['status'],
          'timestamp': session['timestamp'],
        }),
      );

      if (res.statusCode == 201) {
        session['synced'] = true;
        await prefs.setString('warmup_sessions', jsonEncode(sessions));
        debugLog('Session synced to backend');
      } else {
        debugLog('Sync failed: ${res.statusCode} ${res.body}');
      }
    } catch (e) {
      debugLog('Sync error (will retry later): $e');
    }
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  void _showAccountPicker() async {
    // Always fetch fresh accounts from backend before showing picker
    try {
      final backendAccounts = await WarmupApi.getAccountsFromBackend();
      if (backendAccounts.isNotEmpty && mounted) {
        setState(() => _savedAccounts = backendAccounts);
        // If selected account no longer exists, deselect
        if (_selectedAccount.isNotEmpty && !backendAccounts.any((a) => (a['username'] ?? '') == _selectedAccount)) {
          setState(() => _selectedAccount = '');
        }
      }
    } catch (_) {}
    if (_savedAccounts.isEmpty) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: sfCard,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 12),
            Container(width: 40, height: 4, decoration: BoxDecoration(color: sfBorder, borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 16),
            ..._savedAccounts.map((acc) {
              final username = (acc['username'] ?? '') as String;
              final picUrl = (acc['profile_pic_url'] ?? '') as String;
              final selected = username == _selectedAccount;
              return ListTile(
                leading: picUrl.isNotEmpty
                    ? CircleAvatar(radius: 18, backgroundImage: NetworkImage(picUrl), backgroundColor: sfGreen.withValues(alpha: 0.2))
                    : CircleAvatar(radius: 18, backgroundColor: sfGreen.withValues(alpha: 0.2), child: Icon(Icons.person, color: sfGreen, size: 18)),
                title: Text('@$username', style: TextStyle(color: selected ? sfGreen : sfTextPrimary, fontWeight: selected ? FontWeight.bold : FontWeight.normal)),
                trailing: Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: InstagramLogo(size: 22),
                ),
                onTap: () {
                  setState(() => _selectedAccount = username);
                  SharedPreferences.getInstance().then((p) => p.setString('last_account', username));
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
    final metrics = _parseMetrics();
    return Scaffold(
      backgroundColor: sfBg,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Instagram Account', style: TextStyle(color: sfTextSecondary, fontSize: 14)),
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
                        ? Builder(builder: (_) {
                            final acc = _savedAccounts.cast<Map<String, dynamic>>().firstWhere(
                              (a) => (a['username'] ?? '') == _selectedAccount,
                              orElse: () => <String, dynamic>{},
                            );
                            final picUrl = (acc['profile_pic_url'] ?? '') as String;
                            return picUrl.isNotEmpty
                                ? CircleAvatar(radius: 14, backgroundImage: NetworkImage(picUrl))
                                : const Icon(Icons.person, color: sfGreen, size: 20);
                          })
                        : const Icon(Icons.person, color: sfGreen, size: 20),
                    const SizedBox(width: 12),
                    Text(
                      _selectedAccount.isEmpty ? 'Select account...' : '@$_selectedAccount',
                      style: TextStyle(color: _selectedAccount.isEmpty ? sfTextSecondary : sfTextPrimary, fontSize: 16),
                    ),
                    const Spacer(),
                    InstagramLogo(size: 20),
                    const SizedBox(width: 8),
                    const Icon(Icons.chevron_right, color: sfTextSecondary),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            Text('Duration', style: TextStyle(color: sfTextSecondary, fontSize: 14)),
            const SizedBox(height: 8),
            Row(
              children: [2, 5, 10, 20].map((d) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: ChoiceChip(
                    label: Text('${d} min'),
                    selected: _selectedDuration == d,
                    selectedColor: sfGreen,
                    backgroundColor: sfCard,
                    side: const BorderSide(color: sfBorder),
                    labelStyle: TextStyle(
                      color: _selectedDuration == d ? Colors.black : sfTextSecondary,
                      fontWeight: FontWeight.bold,
                    ),
                    onSelected: _isRunning ? null : (_) => setState(() => _selectedDuration = d),
                  ),
                ),
              )).toList(),
            ),
            const SizedBox(height: 32),

            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _status == 'paused'
                    ? () async { await WarmupApi.resumeWarmup(); }
                    : _isRunning
                        ? () async { await WarmupApi.pauseWarmup(); }
                        : _startWarmup,
                style: FilledButton.styleFrom(
                  backgroundColor: _status == 'paused'
                      ? const Color(0xFF3b82f6)
                      : _isRunning
                          ? const Color(0xFFf97316)
                          : sfGreen,
                  foregroundColor: _status == 'paused' || _isRunning ? Colors.white : Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                icon: Icon(
                  _status == 'paused' ? Icons.play_arrow
                    : _isRunning ? Icons.pause
                    : Icons.play_arrow,
                ),
                label: Text(
                  _status == 'paused' ? 'Resume Warmup' :
                  _isRunning ? 'Pause Warmup' : 'Start Warmup',
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

  Map<String, dynamic> _parseMetrics() {
    try {
      return jsonDecode(_metrics) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  Widget _MetricItem({required String value, required String label}) {
    return Column(
      children: [
        Text(value, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: sfTextPrimary)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: sfTextSecondary)),
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
  List<Map<String, dynamic>> _accounts = [];
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadSavedAccounts();
  }

  Future<void> _loadSavedAccounts() async {
    // Try backend first, fallback to local
    try {
      final backendAccounts = await WarmupApi.getAccountsFromBackend();
      if (backendAccounts.isNotEmpty && mounted) {
        setState(() => _accounts = backendAccounts);
        return;
      }
    } catch (_) {}
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString('detected_accounts');
      if (saved != null) {
        final List<dynamic> decoded = jsonDecode(saved);
        if (mounted) setState(() => _accounts = decoded.map((a) {
          if (a is Map<String, dynamic>) return a;
          return {'username': a.toString(), 'profile_pic_url': ''};
        }).toList());
      }
    } catch (e) {
      debugLog('Error loading saved accounts: $e');
    }
  }

  Future<void> _loadAccounts() async {
    setState(() => _loading = true);
    try {
      debugLog('SCAN: Starting account detection...');
      // Ensure device is registered before scanning
      await AuthService.registerDevice();
      final rawJson = await WarmupApi.detectAccounts();
      debugLog('SCAN: detectAccounts returned: $rawJson');
      final List<dynamic> decoded = jsonDecode(rawJson);
      debugLog('SCAN: decoded count: ${decoded.length}');
      final usernames = decoded.map((a) {
        if (a is Map) return (a['username'] ?? '').toString();
        return a.toString();
      }).where((a) => a.isNotEmpty).toList();
      debugLog('SCAN: usernames to sync: $usernames');

      // Sync to backend (this triggers profile pic scraping)
      await WarmupApi.syncAccountsToBackend(usernames);

      // Load from backend (now with profile pics)
      final backendAccounts = await WarmupApi.getAccountsFromBackend();
      debugLog('SCAN: backend returned ${backendAccounts.length} accounts');
      if (backendAccounts.isNotEmpty && mounted) {
        setState(() => _accounts = backendAccounts);
      } else {
        debugLog('SCAN: backend empty, using fallback local data');
        final accounts = decoded.map((a) {
          if (a is Map<String, dynamic>) return a;
          return {'username': a.toString(), 'profile_pic_url': ''};
        }).toList();
        if (mounted) setState(() => _accounts = accounts);
      }

      // Also save locally as backup
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('detected_accounts', jsonEncode(_accounts));
    } catch (e) {
      debugLog('SCAN ERROR: $e');
      // On error, try loading from local cache or backend
      try {
        final backendAccounts = await WarmupApi.getAccountsFromBackend();
        if (backendAccounts.isNotEmpty && mounted) {
          debugLog('SCAN ERROR: loaded ${backendAccounts.length} accounts from backend as fallback');
          setState(() => _accounts = backendAccounts);
        } else {
          final prefs = await SharedPreferences.getInstance();
          final cached = prefs.getString('detected_accounts');
          if (cached != null && mounted) {
            debugLog('SCAN ERROR: loaded accounts from local cache as fallback');
            setState(() => _accounts = (jsonDecode(cached) as List).cast<Map<String, dynamic>>());
          }
        }
      } catch (e2) {
        debugLog('SCAN ERROR fallback also failed: $e2');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: sfBg,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 16),
            Text('Accounts', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: sfTextPrimary)),
            const SizedBox(height: 4),
            Text('Detected Instagram accounts', style: const TextStyle(fontSize: 14, color: sfTextSecondary)),
            const SizedBox(height: 20),
            // Always-visible scan button
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _loadAccounts,
                icon: const Icon(Icons.search),
                label: const Text('Scan accounts'),
                style: ElevatedButton.styleFrom(backgroundColor: sfGreen, foregroundColor: Colors.black),
              ),
            ),
            const SizedBox(height: 16),
            if (_loading)
              const Center(child: CircularProgressIndicator(color: sfGreen))
            else if (_accounts.isEmpty)
              Center(
                child: Column(
                  children: [
                    Icon(Icons.person_outline, size: 48, color: sfTextSecondary),
                    const SizedBox(height: 12),
                    Text('No accounts found', style: TextStyle(color: sfTextSecondary, fontSize: 16)),
                    const SizedBox(height: 16),
                    ElevatedButton.icon(
                      onPressed: _loadAccounts,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Scan'),
                      style: ElevatedButton.styleFrom(backgroundColor: sfGreen, foregroundColor: Colors.black),
                    ),
                  ],
                ),
              )
            else
              ..._accounts.map((acc) {
                final username = acc['username'] ?? acc.toString();
                final picUrl = acc['profile_pic_url'] ?? '';
                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: sfCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: sfBorder)),
                  child: Row(
                    children: [
                      picUrl.isNotEmpty
                          ? CircleAvatar(
                              radius: 20,
                              backgroundColor: sfGreen.withValues(alpha: 0.2),
                              backgroundImage: NetworkImage(picUrl),
                            )
                          : CircleAvatar(radius: 20, backgroundColor: sfGreen.withValues(alpha: 0.2), child: Icon(Icons.person, color: sfGreen)),
                      const SizedBox(width: 12),
                      Expanded(child: Text('@$username', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: sfTextPrimary))),
                      InstagramLogo(size: 20),
                    ],
                  ),
                );
              }),
          ],
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
    // Reload when screen becomes visible
    _loadSessions();
  }

  void reload() {
    _loadSessions();
  }

  void debugLog(String msg) {
    print('[SouthFarm] $msg');
  }

  Future<void> _loadSessions() async {
    setState(() => _loading = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> decoded = jsonDecode(sessionsJson);

      List<Map<String, dynamic>> local = decoded.map((e) => Map<String, dynamic>.from(e as Map)).toList();

      // Fetch backend sessions
      List<Map<String, dynamic>> backend = [];
      final token = prefs.getString('auth_token');
      if (token != null) {
        final res = await http.get(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {'Authorization': 'Bearer $token'},
        );
        if (res.statusCode == 200) {
          final data = jsonDecode(res.body);
          backend = (data['sessions'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
        }
      }

      // Merge + dedupe by id or timestamp fallback
      final Map<String, Map<String, dynamic>> map = {};
      for (final s in [...backend, ...local]) {
        final key = (s['id'] ?? s['timestamp'] ?? '').toString();
        if (key.isEmpty) continue;
        map[key] = s;
      }

      final merged = map.values.toList();
      merged.sort((a, b) => (b['timestamp'] ?? '').compareTo(a['timestamp'] ?? ''));

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
      final token = prefs.getString('auth_token');
      if (token == null) return;
      final sessionsJson = prefs.getString('warmup_sessions') ?? '[]';
      final List<dynamic> sessions = jsonDecode(sessionsJson);
      for (final s in sessions) {
        if (s['synced'] == true) continue;
        final res = await http.post(
          Uri.parse('$API_BASE/warmup-sessions'),
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
          body: jsonEncode({
            'account': s['account'],
            'duration_minutes': s['duration_minutes'],
            'reels_viewed': s['reels_viewed'] ?? 0,
            'likes': s['likes'] ?? 0,
            'saves': s['saves'] ?? 0,
            'elapsed_sec': s['elapsed_sec'] ?? 0,
            'status': s['status'] ?? 'completed',
            'timestamp': s['timestamp'],
          }),
        );
        if (res.statusCode == 201) {
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
        onRefresh: () async { await _loadSessions(); await _syncToBackend(); },
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
                  Text('History', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: sfTextPrimary)),
                  IconButton(
                    onPressed: _syncToBackend,
                    icon: Icon(Icons.cloud_upload_outlined, color: sfTextSecondary),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text('${_sessions.length} sesiones', style: const TextStyle(fontSize: 14, color: sfTextSecondary)),
              const SizedBox(height: 20),
              if (_loading)
                const Center(child: CircularProgressIndicator(color: sfGreen))
              else if (_sessions.isEmpty)
                Center(
                  child: Column(
                    children: [
                      Icon(Icons.history, size: 48, color: sfTextSecondary),
                      const SizedBox(height: 12),
                      Text('No sessions yet', style: TextStyle(color: sfTextSecondary, fontSize: 16)),
                    ],
                  ),
                )
              else
                ..._sessions.map((s) => Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: sfCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: sfBorder)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('@${s['account'] ?? '?'}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: sfGreen)),
                          Text(_formatTime(s['timestamp']), style: const TextStyle(fontSize: 12, color: sfTextSecondary)),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceAround,
                        children: [
                          _metric('${s['reels_viewed'] ?? 0}', 'Reels', sfGreen),
                          _metric('${s['likes'] ?? 0}', 'Likes', const Color(0xFFf472b6)),
                          _metric('${s['saves'] ?? 0}', 'Saves', const Color(0xFFfbbf24)),
                          _metric('${s['duration_minutes'] ?? '?'}min', 'Duration', sfTextSecondary),
                        ],
                      ),
                    ],
                  ),
                )),
            ],
          ),
        ),
      ),
    );
  }

  Widget _metric(String value, String label, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: color)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 11, color: sfTextSecondary)),
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
