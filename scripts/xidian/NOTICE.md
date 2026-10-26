# Third-party notices

Pinned source: [BenderBlog/traintime_pda](https://github.com/BenderBlog/traintime_pda/tree/e780e4d01ea740c979ff5c31b9db439dbc586864).

`src/infrastructure/xidian/client.ts` and `timetable.ts` adapt the IDS login,
MFA and eHall field protocols from the upstream `lib/repository/ids_session/`
files and are licensed MPL-2.0. They are separate files; the project's existing
license is unchanged. The full upstream MPL license is in [MPL-2.0.txt](MPL-2.0.txt).
Copyright 2023-2025 BenderBlog Rodriguez and contributors; 2025-2026 Traintime PDA authors.
Modifications: Node HTTP client, bounded refresh, redacted errors, private snapshots,
strict parsing, conservative class-change resolution, and local query integration.

`solve-slider.py` adapts the image matching algorithm from
`lib/repository/ids_session/slider_captcha_client.dart`, marked MIT upstream.
Copyright 2023-2025 BenderBlog Rodriguez and contributors; 2025 Traintime PDA authors.
The Python port uses the existing local Pillow runtime and no external image service.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
