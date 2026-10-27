@echo off
setlocal
set "DEST=C:\dbclone\local-ai"
set "CACHE=C:\dbclone\gemma-download"
set "BASE=https://tas-ui.example.workers.dev/api/assets/files"
echo Gemma 4 E4B QAT / llama.cpp b10964 / Windows x64 CPU
echo About 7.2 GB download; reserve 20 GB free disk. Re-run to resume verified parts.
echo At 10 Mbps allow about 100 minutes; at 100 Mbps about 10 minutes, plus verification.
for %%T in (curl.exe certutil.exe tar.exe findstr.exe) do where %%T >nul 2>nul || (echo BREAK: missing %%T & exit /b 1)
if not exist "%DEST%" mkdir "%DEST%" || exit /b 1
if not exist "%CACHE%" mkdir "%CACHE%" || exit /b 1
cd /d "%CACHE%" || exit /b 1
echo [Runtime] Download and verify official package
call :check "llama-cpu.zip" "917f39c076402c421224824607397af20f53625a60defc20e8dd22446bf4c5d7" && goto runtime_ready
curl.exe --ssl-revoke-best-effort -fL --connect-timeout 20 --max-time 600 --retry 2 "%BASE%/gemma-e4b-20260917-runtime.b64.txt" -o runtime.b64.txt || goto fail
certutil -f -decode runtime.b64.txt llama-cpu.zip || goto fail
call :check "llama-cpu.zip" "917f39c076402c421224824607397af20f53625a60defc20e8dd22446bf4c5d7" || goto fail
:runtime_ready
if not exist "%DEST%\runtime" mkdir "%DEST%\runtime" || goto fail
tar.exe -xf llama-cpu.zip -C "%DEST%\runtime" || goto fail
"%DEST%\runtime\llama-server.exe" --version || goto fail
echo [Model] Checking existing complete file; this may take a minute
call :check "%DEST%\gemma-4-E4B_q4_0-it.gguf" "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee" && goto model_ready
echo [Model 1/103]
call :part "part001" "42e5832846def032a2db1ff5251c1ead30378d48b8e4472ff072128a9e4c45ec" || goto fail
echo [Model 2/103]
call :part "part002" "28491e8f3d82d4849faaf75b2ff694f25dbdcaa9ed9c9b9d4330582d0cc8a8f2" || goto fail
echo [Model 3/103]
call :part "part003" "ed4c71311e553e4f342e19406383daeec2e6c2f9ca7cbc09dc8a1bc24ddfd987" || goto fail
echo [Model 4/103]
call :part "part004" "bc647a1d3f3a2cc6ce77c20f97fc856f0e72e4bb6840b480c9e112643967f29f" || goto fail
echo [Model 5/103]
call :part "part005" "e58ef8821616d4ee0e0c5e5e023d4d6b265bf9ca128f3e4fa9a67d48b534ddfd" || goto fail
echo [Model 6/103]
call :part "part006" "2cd197e2401a3b5f85408b4df7cb27e83c364191d43809f6acd09cbe2367e71f" || goto fail
echo [Model 7/103]
call :part "part007" "fa3b0be9cbed107b21907748876616a1b7caf39a4b1c5a3aa556634b1ef31e92" || goto fail
echo [Model 8/103]
call :part "part008" "3d327679d71e406d12df2ef695010e09929bff3d3fd244f27d7368fe8971d5f7" || goto fail
echo [Model 9/103]
call :part "part009" "765a6bf48c02d71c8789afd31c71c3d863718f52402832beecaac6f5f13240af" || goto fail
echo [Model 10/103]
call :part "part010" "0659db11e9794f1fbf4e034660dd363ce7cc5c09708fc157ddb5792f220a0ee8" || goto fail
echo [Model 11/103]
call :part "part011" "bdf81b5aaf20010820613bd6129816db11d7a2e64323cdbf26f196e4fcae4a5e" || goto fail
echo [Model 12/103]
call :part "part012" "ec331ee2a7609ea0d41f7d8f0d2fa49868c03a6888cd9f18a54a58fd74da2b22" || goto fail
echo [Model 13/103]
call :part "part013" "0160414e3061cc824ccf47e701cf0b625da3f865e5c20ec7cce4311677515b01" || goto fail
echo [Model 14/103]
call :part "part014" "37831dcd2a051c33810a5fbabdea34b4b73af2551c68bb2f4bf21a71133c4033" || goto fail
echo [Model 15/103]
call :part "part015" "dd0917baf0298df058d40ff89ec1e26a1f7866a1c26b9d1cd13e67e81c3bc1ea" || goto fail
echo [Model 16/103]
call :part "part016" "4d45eedde5b7c0d1da6c02b34a9d4e1bb5829fc8adaf0b71721ad93cdfae1c43" || goto fail
echo [Model 17/103]
call :part "part017" "5fc9f2abfa7e176f943490d9cc63d35f83bc98b6a62a45e62cfc1be56246e874" || goto fail
echo [Model 18/103]
call :part "part018" "d8d8b86f2ac64773f6b83966c2e83b5185490cf839dbab3836388aaadd1f5e07" || goto fail
echo [Model 19/103]
call :part "part019" "8317f6ec1520074a113526e9fabb952b0cf7303bf232e1405dc7334a410a96d5" || goto fail
echo [Model 20/103]
call :part "part020" "73eea212b91ad03f20e9ebf9eaed5f479dd13e781fffc590b82e3d8958269860" || goto fail
echo [Model 21/103]
call :part "part021" "882745f90d1e726a528c13bad6d0ca24f2a0d97fc8d625214a924dac152933eb" || goto fail
echo [Model 22/103]
call :part "part022" "bbf0fb60a56d2f7b666acf8fc37187349fcb9c10b4273a008676b4b5cd864b26" || goto fail
echo [Model 23/103]
call :part "part023" "0f90094c706eca19fa1aa9e14ea69b854c182a905c9523d3a0d531594f6c0e49" || goto fail
echo [Model 24/103]
call :part "part024" "0d60bf68591930730cde42d41723d66c43afa2623b6868f14f282600df9902f8" || goto fail
echo [Model 25/103]
call :part "part025" "26a5bc3dbed271076aa1ef36252c152b4e97407328c1002acc714b8f85a5339a" || goto fail
echo [Model 26/103]
call :part "part026" "526f2e6de4dee779b5beffe8a7f2a46e78e29a2141d6cdc124ade70025e78bf1" || goto fail
echo [Model 27/103]
call :part "part027" "9045166d5ad1c8263b717b6b9209f1ebd980dc70826e19bd1e656ab136f3e0f4" || goto fail
echo [Model 28/103]
call :part "part028" "8036c7c380bdffa90389bdf8f2025295aa11ca7ebf9cd15ecd44f96f6eff67be" || goto fail
echo [Model 29/103]
call :part "part029" "69d723ef13163141aaa6b53f917bd4fb9f7a2269d1c5c0e48771c44b42c6c0a4" || goto fail
echo [Model 30/103]
call :part "part030" "123c3c74f5272707463cc34effb8294bd6b41ee2b214bddfe63d3439a02a9e60" || goto fail
echo [Model 31/103]
call :part "part031" "bf66d128c974bbe7c70318ba8222fcbf8aa638a355a24431634a26edb73d2bf6" || goto fail
echo [Model 32/103]
call :part "part032" "b6860fde5fb209375e1b723cd9596fceb56ea55af48a2d50cebaf4409846c7b5" || goto fail
echo [Model 33/103]
call :part "part033" "4739a2086b679b58ad74dc9a83912256180d5e8d606da02b062d6e0efa7aea0b" || goto fail
echo [Model 34/103]
call :part "part034" "452c194ffad20e42e10de2acc8b09d07d0c7a4ecc112631c329b0d75071acecb" || goto fail
echo [Model 35/103]
call :part "part035" "3093ef8bb5ca511534305b4105a59af592efb7a75e1400abac2f18c57ea44ffe" || goto fail
echo [Model 36/103]
call :part "part036" "d20fb5a94f5bd1f3761131e7239f3994654f73785646ab2ab5552c0a4450795b" || goto fail
echo [Model 37/103]
call :part "part037" "ff0a7a1a1f69af28ce7bffcc7b231248c68b7358e0c73236dc8e120f9b6996ad" || goto fail
echo [Model 38/103]
call :part "part038" "127e965e4a864313b42496f485f2bd2b05386035ef87485a49a07f2b9d20b73c" || goto fail
echo [Model 39/103]
call :part "part039" "512d88694ce498d2037d19a7f62b44586cdc0d3efdce1e3d1cb6c95b75e14765" || goto fail
echo [Model 40/103]
call :part "part040" "e3780f8ff9b6042a2ed18a100eef872148c9cd2cccbd595b0afe3d376aa9a2a8" || goto fail
echo [Model 41/103]
call :part "part041" "85513dc82c247437480d23f2eb20844d4c03c703b7020b58429a60b135906319" || goto fail
echo [Model 42/103]
call :part "part042" "067208a74513ed9932b6b9801d7fc218c2f93e0a8c98c3e148de050847795487" || goto fail
echo [Model 43/103]
call :part "part043" "86642b9e6f3c042238d8538f3c6abcbecb3e4c5f4f0051fb7cba6e5d0a7abdf2" || goto fail
echo [Model 44/103]
call :part "part044" "31016f7555979d2319a98dd98a5ed4f7463a87cf84f125721dc6eda6bf311e96" || goto fail
echo [Model 45/103]
call :part "part045" "f2a6567253222c5449974a3a7eaf2dd69f6deb4f1349bc3240c456d979f6c75a" || goto fail
echo [Model 46/103]
call :part "part046" "b974e39cc3e6deaf1c9e26e3267ba1bb5e1478b79affd83fea083a15c13ba81f" || goto fail
echo [Model 47/103]
call :part "part047" "a0097d996cdaead8da37fe7577d4380a2f5598b9b57f2d12e9321bfc98768a01" || goto fail
echo [Model 48/103]
call :part "part048" "07d6a4633bf7f229a20e0ff19ffbdbee9c0e22a685b503db265153ca5cd01ea3" || goto fail
echo [Model 49/103]
call :part "part049" "c6dbf2460674d507d6f61eff994048dfd8925893ead89f6c5f9710c4b3277fa3" || goto fail
echo [Model 50/103]
call :part "part050" "0c4b0807cc4f8bec627661f366c94d66def6f09ca6a0c0e30705130c55bb067c" || goto fail
echo [Model 51/103]
call :part "part051" "d2dc8e5a79ae6128d21d4a4c114c801b46cb18316fcc821b2d21d3309ae5117e" || goto fail
echo [Model 52/103]
call :part "part052" "a0e5c5b54042b827549c4e3a5000e01a632815258900dd007b1f63324f45b0aa" || goto fail
echo [Model 53/103]
call :part "part053" "a05ca76d2825b0336c3bea8e07efc1725f6f9666c8c3fa169a8c185e72324f76" || goto fail
echo [Model 54/103]
call :part "part054" "f42fc92294bc07fad3f9b02da9d3944d8c94ad556e350fbc84b36593fe7cd8cc" || goto fail
echo [Model 55/103]
call :part "part055" "e855cf975533519f899f928d80c78f56ae63346b39d16a9edd099beebf47f18a" || goto fail
echo [Model 56/103]
call :part "part056" "ae446cf4cbe5aa05fb62c373b032370e9c0a2b69ed1dc700338de3ed7615a3b6" || goto fail
echo [Model 57/103]
call :part "part057" "27789e6f5c1c13d69d70bc229dca2744a0657162ddcee2d2eb8dadc7b2651d10" || goto fail
echo [Model 58/103]
call :part "part058" "5bddd7f346b08550bdaa56d2571486e5da2270b67c10e4dcc3359cff758bbf31" || goto fail
echo [Model 59/103]
call :part "part059" "78a867bb8eac68caf0e285c7aa311bbe4dbce9d1db3d6f814b9116188356eab1" || goto fail
echo [Model 60/103]
call :part "part060" "c81f4e865f6fdf0a96723bf04e0cf95c1e3176335d5ebd0b070d6da72a9780e8" || goto fail
echo [Model 61/103]
call :part "part061" "42a2928d1c813ba4d07941453ff4f090285c5c1dd81902c8a7bae984533331b1" || goto fail
echo [Model 62/103]
call :part "part062" "2e4f3675f1df4efe91bc56d2afb9c5fe6dad164bb6c66e1aad5d7e97abc0c29b" || goto fail
echo [Model 63/103]
call :part "part063" "3be4eed294ab2546357021e159eaa30053366a54d6e0ae969d64ff71e8b6b29f" || goto fail
echo [Model 64/103]
call :part "part064" "ca7001e5fa938f34d3699e158d4409726015692158005ca742c80ffb16314958" || goto fail
echo [Model 65/103]
call :part "part065" "a21359d4ad122dcbfca34c4438c8a0f34cbb6f77018244d4de270c55dc67f8c2" || goto fail
echo [Model 66/103]
call :part "part066" "958d3a7cd88fe51869824958b805aa574c4cab1b76b8c818d120b6780b06701c" || goto fail
echo [Model 67/103]
call :part "part067" "2a39d25495252d0d3838ed32bfa45b5297dfc768566a73dad53675440fe1be71" || goto fail
echo [Model 68/103]
call :part "part068" "6ce083f188517725c98aa75e86052c5afe204de72e93f2953b325ba0e43e9f19" || goto fail
echo [Model 69/103]
call :part "part069" "22ebb9194a693a959da4015455246e7297748d0012acc4ed1db2860f8e431b70" || goto fail
echo [Model 70/103]
call :part "part070" "400d0efc8914e300454c6307c59696ebb7d51dbc2db5bc08cd8663c2fc209204" || goto fail
echo [Model 71/103]
call :part "part071" "807701ba82e71819a461fed1bc3dc0cc0230deb5c52f31c0743d14ae3afe1fe3" || goto fail
echo [Model 72/103]
call :part "part072" "ba75a90050b1b140a0842a921309d9693dc281cee0780875d0d910323fcc8b6e" || goto fail
echo [Model 73/103]
call :part "part073" "56673f524ebf37d833b12523f709909f51c6329ecee10004d43b1a838407a547" || goto fail
echo [Model 74/103]
call :part "part074" "b6099029793dfd85ab7ed0eae0a2feb06817711b2690f85ea2a28f1e191fcd52" || goto fail
echo [Model 75/103]
call :part "part075" "4401ba2b003cb7a64cf5037034032f50308c26a065ec66baf2908c426046735a" || goto fail
echo [Model 76/103]
call :part "part076" "d50b1eef5f7a1d2ead90f14080b75406ca8162f0244c0a658af930c9c970d82a" || goto fail
echo [Model 77/103]
call :part "part077" "80ce9e85fc57e0126071bd1a70ecda18790dfa6115e4c7312db8844a1b35481b" || goto fail
echo [Model 78/103]
call :part "part078" "479f3a754a5b02bc77647020f15e17b0c203ddb6793c7cd47f2718ac9fd3c4d5" || goto fail
echo [Model 79/103]
call :part "part079" "a46503b9345f7c8b9cc3e227b7914dd56d9b4c316cbd7bfdb83c3b1604c1f607" || goto fail
echo [Model 80/103]
call :part "part080" "42698fc19d3587cf49d5a8bb087d25db45c4a5fef3208b02107895d9ade4f53e" || goto fail
echo [Model 81/103]
call :part "part081" "c6fdc6af82d7df4ed2878c87152694037bf23a4d9d3a5305bfe5fa8a0d9849f7" || goto fail
echo [Model 82/103]
call :part "part082" "de977ae8a8a63e92e953ba8c012fb17798ba3765b4fa7d6c46be4883d2760bd6" || goto fail
echo [Model 83/103]
call :part "part083" "827bf904849531d1c186026452119240a64251d1c5ce30b7951f2e435ad6348e" || goto fail
echo [Model 84/103]
call :part "part084" "02a74f5bd53f458e7ead52b52442fa54b76e3529b511803ad0029449e122c1bc" || goto fail
echo [Model 85/103]
call :part "part085" "706ff29e57f072fef3a6439015e65e9f836e990c471229dbd4ac0ab01e550e26" || goto fail
echo [Model 86/103]
call :part "part086" "56fea4294288b8a182db6eb21f9635c2c9e9eacecaad784dc67eb3af1cdce718" || goto fail
echo [Model 87/103]
call :part "part087" "23b5bd1c13879a48f81d2db1bb271a092a7fe22dc3ed3c6535f37e0e05cbf086" || goto fail
echo [Model 88/103]
call :part "part088" "432ed5043ad9868d793c8ec61301dbe432dff971688123e8814e808529c9c2b9" || goto fail
echo [Model 89/103]
call :part "part089" "eb263c1fd3d0f556c52a53935a6de8103a12003ce5249d157ebf224bf0d0d276" || goto fail
echo [Model 90/103]
call :part "part090" "cb767275b80a3d2c8e646b621a6c11fed4194aa4c03fb0886588508a4b4eb5b9" || goto fail
echo [Model 91/103]
call :part "part091" "ee113f333dccabc7bdb9347aaea586c632d30992d4671e9188b761120ca1c85f" || goto fail
echo [Model 92/103]
call :part "part092" "42911b7d096f3677eccc5e86472f32b5a05a1435d6736745cd67542061251b7f" || goto fail
echo [Model 93/103]
call :part "part093" "02bdd858444a93175d5cf3371039b66f4146007f04affad1c0a4c3906f671765" || goto fail
echo [Model 94/103]
call :part "part094" "9714605460c7a70bae4980857b20fd588989cfaf9d6eb5cc20658e9665957503" || goto fail
echo [Model 95/103]
call :part "part095" "867864413947959506071537a1d12c383d63a496acba3ec7e57e5df91fab1242" || goto fail
echo [Model 96/103]
call :part "part096" "f184707c4d8b62fff4a5204e071e709bd957cb5bdf1d1fc9a522095dad7480f6" || goto fail
echo [Model 97/103]
call :part "part097" "5e53d631d4833ebf50c8aa847478c2841991c07dea2b110047e081563a1e689a" || goto fail
echo [Model 98/103]
call :part "part098" "11ad260d011eb589a637c0c37d7f4b0b1270a2428c1e41adb9db08746c211a43" || goto fail
echo [Model 99/103]
call :part "part099" "54627cab38e4f897be41bba8371451224b5c221b4c269eb8e0713b64bdaf7f13" || goto fail
echo [Model 100/103]
call :part "part100" "585b99f491ffb0e35e53c8a09addd0f94ed61dae8d83cff0c626fd2f63e2bd56" || goto fail
echo [Model 101/103]
call :part "part101" "0c204f17ebe246e39195f68e7de1276781c50a18aa856afb447994f57035a670" || goto fail
echo [Model 102/103]
call :part "part102" "659df4fa52f4fb44f5372f89fe2920a5aff948f0222c6fc089ddd5fd2c54c2e5" || goto fail
echo [Model 103/103]
call :part "part103" "0047ec8e41e61515b039782d0a551d110af999ef92e89e63a04f913974e638fa" || goto fail
echo [Model] Joining verified parts - allow a few minutes
copy /b part001.bin+part002.bin+part003.bin+part004.bin+part005.bin+part006.bin+part007.bin+part008.bin+part009.bin+part010.bin+part011.bin+part012.bin+part013.bin+part014.bin+part015.bin+part016.bin+part017.bin+part018.bin+part019.bin+part020.bin+part021.bin+part022.bin+part023.bin+part024.bin+part025.bin+part026.bin+part027.bin+part028.bin+part029.bin+part030.bin+part031.bin+part032.bin+part033.bin+part034.bin+part035.bin+part036.bin+part037.bin+part038.bin+part039.bin+part040.bin+part041.bin+part042.bin+part043.bin+part044.bin+part045.bin+part046.bin+part047.bin+part048.bin+part049.bin+part050.bin+part051.bin+part052.bin+part053.bin+part054.bin+part055.bin+part056.bin+part057.bin+part058.bin+part059.bin+part060.bin+part061.bin+part062.bin+part063.bin+part064.bin+part065.bin+part066.bin+part067.bin+part068.bin+part069.bin+part070.bin+part071.bin+part072.bin+part073.bin+part074.bin+part075.bin+part076.bin+part077.bin+part078.bin+part079.bin+part080.bin+part081.bin+part082.bin+part083.bin+part084.bin+part085.bin+part086.bin+part087.bin+part088.bin+part089.bin+part090.bin+part091.bin+part092.bin+part093.bin+part094.bin+part095.bin+part096.bin+part097.bin+part098.bin+part099.bin+part100.bin+part101.bin+part102.bin+part103.bin "%DEST%\gemma-4-E4B_q4_0-it.gguf.partial" >nul || goto fail
echo [Model] Verifying complete official SHA256
call :check "%DEST%\gemma-4-E4B_q4_0-it.gguf.partial" "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee" || goto fail
move /y "%DEST%\gemma-4-E4B_q4_0-it.gguf.partial" "%DEST%\gemma-4-E4B_q4_0-it.gguf" >nul || goto fail
:model_ready
cd /d "%DEST%" || goto fail
call :fetch "gemma-e4b-20260917-start-gemma.cmd.txt" "start-gemma.cmd" "a00ba60ad99ea0b143f36fe45f18465efbef3bb1ac12cf00f60c04cc533808e1" || goto fail
call :fetch "gemma-e4b-20260917-test-gemma.cmd.txt" "test-gemma.cmd" "3945e1de4663ee665ba35180b8254780182345289fbda556654a60461d767929" || goto fail
call :fetch "gemma-e4b-20260917-smoke-request.json.txt" "smoke-request.json" "56e9f9e59791a4fdd1dfe28f1f06c266c2a45ad4b0e0ebe0c49427dd583c1d39" || goto fail
call :fetch "gemma-e4b-20260917-llama-LICENSE.txt.txt" "llama-LICENSE.txt" "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d" || goto fail
echo.
echo INSTALL PASS. No database changes were made.
echo Run C:\dbclone\local-ai\start-gemma.cmd
echo In a second CMD run C:\dbclone\local-ai\test-gemma.cmd
echo Send smoke-response.json back after the test.
exit /b 0
:check
if not exist "%~1" exit /b 1
certutil -hashfile "%~1" SHA256 | findstr /i /x /c:"%~2" >nul
exit /b %errorlevel%
:part
call :check "%~1.bin" "%~2" && exit /b 0
curl.exe --ssl-revoke-best-effort -fL --connect-timeout 20 --max-time 600 --retry 2 "%BASE%/gemma-e4b-20260917-%~1.b64.txt" -o "%~1.b64.txt" || exit /b 1
certutil -f -decode "%~1.b64.txt" "%~1.bin" || exit /b 1
call :check "%~1.bin" "%~2" || exit /b 1
del /q "%~1.b64.txt"
exit /b 0
:fetch
call :check "%~2" "%~3" && exit /b 0
curl.exe --ssl-revoke-best-effort -fL --connect-timeout 20 --max-time 60 --retry 2 "%BASE%/%~1" -o "%~2" || exit /b 1
call :check "%~2" "%~3"
exit /b %errorlevel%
:fail
echo BREAK: previous command failed. Stop and send its error output; do not bypass it.
echo Verified parts remain in C:\dbclone\gemma-download for a re-run.
exit /b 1
