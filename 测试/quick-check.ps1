$base = 'http://localhost:35555'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Write-Output "1. dev-login admin"
try {
  Invoke-WebRequest -UseBasicParsing -WebSession $session -Uri "$base/auth/dev-login?username=admin&admin=1" -TimeoutSec 5 -MaximumRedirection 5 | Out-Null
  Write-Output "   OK (session established)"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "2. GET /forum"
try {
  $forum = Invoke-WebRequest -UseBasicParsing -WebSession $session "$base/forum" -TimeoutSec 5
  Write-Output "   $($forum.StatusCode) len=$($forum.Content.Length)"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "3. POST new forum"
$body = 'title=E2E-test-post&content=hello-from-powershell&category=study&tags=api'
try {
  Invoke-WebRequest -UseBasicParsing -WebSession $session -Method POST -Body $body -ContentType 'application/x-www-form-urlencoded' -Uri "$base/forum" -TimeoutSec 5 -MaximumRedirection 5 | Out-Null
  Write-Output "   OK POST + redirect"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "4. verify post in list"
try {
  $forum2 = Invoke-WebRequest -UseBasicParsing -WebSession $session "$base/forum" -TimeoutSec 5
  $hasTitle = $forum2.Content.Contains('E2E-test-post')
  $hasContent = $forum2.Content.Contains('hello-from-powershell')
  Write-Output "   hasTitle=$hasTitle hasContent=$hasContent"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "5. GET /forum/1 detail (show.ejs)"
try {
  $detail = Invoke-WebRequest -UseBasicParsing -WebSession $session "$base/forum/1" -TimeoutSec 5
  $hasComment = $detail.Content.Contains('评论区')
  Write-Output "   $($detail.StatusCode) len=$($detail.Content.Length) hasComment=$hasComment"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "6. admin toggle-top 1"
try {
  $r = Invoke-WebRequest -UseBasicParsing -WebSession $session -Method POST -Uri "$base/admin/forum/toggle-top/1" -TimeoutSec 5
  Write-Output "   $($r.StatusCode) body=$($r.Content)"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "7. admin toggle-hot 1"
try {
  $r = Invoke-WebRequest -UseBasicParsing -WebSession $session -Method POST -Uri "$base/admin/forum/toggle-hot/1" -TimeoutSec 5
  Write-Output "   $($r.StatusCode) body=$($r.Content)"
} catch { Write-Output "   FAIL: $($_.Exception.Message)" }

Write-Output "8. public pages"
foreach ($p in @('/', '/search', '/secret', '/sponsor', '/messages/guestbook', '/login', '/register')) {
  try { $r = Invoke-WebRequest -UseBasicParsing "$base$p" -TimeoutSec 5; Write-Output "   $p -> $($r.StatusCode)" } catch { Write-Output "   $p -> FAIL" }
}

Write-Output "9. auth pages as admin"
foreach ($p in @('/user', '/messages', '/admin', '/admin/forum', '/admin/settings')) {
  try { $r = Invoke-WebRequest -UseBasicParsing -WebSession $session "$base$p" -TimeoutSec 5; Write-Output "   $p -> $($r.StatusCode)" } catch { Write-Output "   $p -> FAIL" }
}

Write-Output "DONE"
