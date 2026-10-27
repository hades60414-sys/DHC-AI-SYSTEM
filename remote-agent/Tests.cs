using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using DbAgent;

public static class Tests {
    static int passed,failed; static Config c; static X509Certificate2 outer,recipient,device,attacker; static DateTime now=DateTime.UtcNow;static string work;
    static void Check(bool b,string why){if(!b)throw new Exception(why);}
    static T Clone<T>(T v){return Common.Json().Deserialize<T>(Common.Encode(v));}
    static void Test(string name,Action run){try{run();passed++;Console.WriteLine("PASS "+name);}catch(Exception e){failed++;Console.WriteLine("FAIL "+name+": "+e.GetType().Name+" "+e.Message+" @ "+string.Join(" <- ",(e.StackTrace??"").Split('\n').Take(3).Select(l=>l.Trim())));}}
    static void Throws<T>(Action run)where T:Exception {try{run();}catch(T){return;}throw new Exception("Expected "+typeof(T).Name);}
    static AgentState AS(){return new AgentState{Deployment=c.Deployment,Agent=c.Agent,Target=c.Target,DeviceThumb=device.Thumbprint};}
    static ControllerState CS(){return new ControllerState{Deployment=c.Deployment,Agent=c.Agent,Target=c.Target};}
    static ControllerCore Controller(){var ctl=new ControllerCore(c,recipient,outer,CS(),s=>{});ctl.Pair(Enroll(device),Common.Fingerprint(device));return ctl;}
    static string Enroll(X509Certificate2 cert){var d=c.Message("enrollment");d["createdUtc"]=Common.Now();return Common.Seal(Common.Encode(d),cert,recipient);}
    static Dictionary<string,object> Job(long seq=1,string action="health",string prompt="") {var d=c.Message("job");d["seq"]=seq;d["jobId"]=Guid.NewGuid().ToString("D");d["createdUtc"]=now.ToString("o");d["expiresUtc"]=now.AddMinutes(15).ToString("o");d["action"]=action;d["prompt"]=prompt;return d;}
    static string Wire(Dictionary<string,object> d,X509Certificate2 signer=null,X509Certificate2 encryptTo=null){return Common.Seal(Common.Encode(d),signer??outer,encryptTo??device);}
    static AgentCore Agent(){return new AgentCore(c,device,AS(),s=>{});}
    static string Cli(params string[] arguments){var psi=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--cli "+string.Join(" ",arguments.Select(Common.Q))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};using(var p=Process.Start(psi)){string stdout=p.StandardOutput.ReadToEnd(),stderr=p.StandardError.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0)throw new Exception("CLI failed: "+stderr);return stdout;}}
    static void HttpFixture(string[] bodies,int[] statuses,Action<string> run,Action<string> checkRequest=null){
        var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();string address="http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port;
        var server=Task.Factory.StartNew(()=>{for(int i=0;i<bodies.Length;i++){using(var client=listener.AcceptTcpClient()){client.ReceiveTimeout=5000;using(var stream=client.GetStream()){var header=new StringBuilder();while(!header.ToString().EndsWith("\r\n\r\n")){int b=stream.ReadByte();if(b<0)throw new IOException("incomplete HTTP header");header.Append((char)b);if(header.Length>8192)throw new IOException("header overflow");}int length=0;foreach(string line in header.ToString().Split(new[]{"\r\n"},StringSplitOptions.None))if(line.StartsWith("Content-Length:",StringComparison.OrdinalIgnoreCase))length=int.Parse(line.Substring(15).Trim());byte[] request=new byte[length];int offset=0;while(offset<length){int n=stream.Read(request,offset,length-offset);if(n<=0)throw new IOException("incomplete body");offset+=n;}if(checkRequest!=null)checkRequest(header+Encoding.UTF8.GetString(request));var body=Encoding.UTF8.GetBytes(bodies[i]);var response=Encoding.ASCII.GetBytes("HTTP/1.1 "+statuses[i]+(statuses[i]==200?" OK":" Not Found")+"\r\nContent-Length: "+body.Length+"\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n");stream.Write(response,0,response.Length);stream.Write(body,0,body.Length);}}}});
        try{run(address);if(!server.Wait(10000))throw new Exception("HTTP fixture did not complete");}finally{listener.Stop();}
    }
    public static int Main(string[] args){
        if(args.Length>0&&args[0]=="--cli")return Program.Main(args.Skip(1).ToArray());
        if(args.Length>0&&(args[0]=="--hold-lock"||args[0]=="--try-lock")){try{using(var stateLock=Common.LockState(args[1],false)){Console.WriteLine("LOCKED");Console.Out.Flush();if(args[0]=="--hold-lock")Thread.Sleep(30000);return 0;}}catch(IOException){return 5;}}
        outer=Common.Private(args[0]);recipient=Common.Private(args[1]);device=Common.Private(args[2]);attacker=Common.Private(args[3]);work=args[4];Directory.CreateDirectory(work);
        c=Config.Load();
        Test("AES256 / SHA256 signed encrypted round trip",()=>{X509Certificate2 actual;var d=Common.Open(Wire(Job()),device,outer,out actual);Check(Common.S(d,"action")=="health"&&Common.Same(actual,outer),"round trip mismatch");});
        Test("wrong encryption recipient rejects",()=>Throws<InputRejected>(()=>Agent().Handle(Wire(Job(),outer,attacker),(a,p)=>"BAD",now)));
        Test("untrusted signer rejects before execution",()=>{int runs=0;Throws<InputRejected>(()=>Agent().Handle(Wire(Job(),attacker),(a,p)=>{runs++;return "BAD";},now));Check(runs==0,"action ran");});
        Test("tampered ciphertext rejects",()=>{var raw=Convert.FromBase64String(Wire(Job()));raw[raw.Length-20]^=0x40;Throws<InputRejected>(()=>Agent().Handle(Convert.ToBase64String(raw),(a,p)=>"BAD",now));});
        Test("pair requires externally supplied matching fingerprint",()=>{var ctl=new ControllerCore(c,recipient,outer,CS(),s=>{});Throws<CryptographicException>(()=>ctl.Pair(Enroll(device),new string('0',64)));Check(ctl.State.DeviceBase64=="","pinned wrong device");});
        Test("pair cannot silently replace device",()=>{var ctl=Controller();Throws<CryptographicException>(()=>ctl.Pair(Enroll(attacker),Common.Fingerprint(attacker)));});
        Test("unpaired controller cannot submit",()=>{var ctl=new ControllerCore(c,recipient,outer,CS(),s=>{});Throws<InvalidOperationException>(()=>ctl.Submit("health","",now));});
        Test("wrong target rejected without sequence consumption",()=>{var d=Job();d["target"]="10.255.0.11";var a=Agent();Throws<InputRejected>(()=>a.Handle(Wire(d),(x,p)=>"BAD",now));Check(a.State.Seq==0,"sequence consumed");});
        Test("wrong deployment rejected",()=>{var d=Job();d["deploymentId"]=Guid.NewGuid().ToString();Throws<InputRejected>(()=>Agent().Handle(Wire(d),(x,p)=>"BAD",now));});
        Test("wrong host guard rejects before filesystem/agent startup",()=>{var other=new Config{Target="203.0.113.254"};Throws<InvalidOperationException>(()=>other.CheckTarget());});
        Test("expired valid command produces REJECTED without action",()=>{var d=Job();d["createdUtc"]=now.AddHours(-1).ToString("o");d["expiresUtc"]=now.AddMinutes(-1).ToString("o");var a=Agent();int runs=0;a.Handle(Wire(d),(x,p)=>{runs++;return "BAD";},now);Check(runs==0&&a.State.Status=="REJECTED"&&a.State.Outbox!="","not safely rejected");});
        Test("invalid action cannot invoke delegate",()=>{var a=Agent();int runs=0;a.Handle(Wire(Job(1,"sql-execute")),(x,p)=>{runs++;return "BAD";},now);Check(runs==0&&a.State.Status=="REJECTED","invalid action ran");});
        Test("Chinese prompt over byte budget rejects",()=>{var ctl=Controller();Throws<InvalidDataException>(()=>ctl.Submit("reason",new string('\u4e2d',4200),now));var a=Agent();a.Handle(Wire(Job(1,"reason",new string('\u4e2d',4200))),(x,p)=>{throw new Exception("must not run");},now);Check(a.State.Status=="REJECTED","agent budget missing");});
        Test("v2 prompt budget boundary is exactly 12288 UTF-8 bytes",()=>{var ctl=Controller();ctl.Submit("reason",new string('a',12288),now);var ctl2=Controller();Throws<InvalidDataException>(()=>ctl2.Submit("reason",new string('a',12289),now));});
        Test("unknown schema field rejects",()=>{var d=Job();d["shell"]="calc.exe";Throws<InputRejected>(()=>Agent().Handle(Wire(d),(a,p)=>"BAD",now));});
        Test("one outstanding job enforced",()=>{var ctl=Controller();ctl.Submit("health","",now);Throws<InvalidOperationException>(()=>ctl.Submit("stop","",now));});
        Test("pending encrypted command survives missing export file",()=>{var ctl=Controller();string wire=ctl.Submit("reason","short private advisory question",now);var disk=Clone(ctl.State);Check(disk.PendingWire==wire&&!Common.Encode(disk).Contains("short private advisory"),"wire not durable or plaintext leaked");var restored=new ControllerCore(c,recipient,outer,disk,s=>{});Check(restored.State.PendingWire==wire,"cannot export pending job after restart");});
        Test("running journal is saved before delegate",()=>{bool runningSaved=false;var a=new AgentCore(c,device,AS(),s=>{if(s.Status=="RUNNING")runningSaved=true;});a.Handle(Wire(Job()),(x,p)=>{Check(runningSaved,"missing write ahead");return "ok";},now);});
        Test("journal failure before execute stops without action",()=>{int runs=0;var a=new AgentCore(c,device,AS(),s=>{throw new IOException("disk full");});Throws<IOException>(()=>a.Handle(Wire(Job()),(x,p)=>{runs++;return "BAD";},now));Check(runs==0,"action executed despite journal failure");});
        Test("crash running becomes INTERRUPTED and never replays",()=>{AgentState disk=null;string wire=Wire(Job());var a=new AgentCore(c,device,AS(),s=>{disk=Clone(s);throw new IOException("simulated power loss after running flush");});Throws<IOException>(()=>a.Handle(wire,(x,p)=>"BAD",now));Check(disk.Status=="RUNNING","fixture missing durable RUNNING");var restored=new AgentCore(c,device,disk,s=>{});restored.Recover();Check(restored.State.Status=="INTERRUPTED"&&restored.State.Outbox!="","not interrupted");restored.FlushOutbox(w=>true);int runs=0;restored.Handle(wire,(x,p)=>{runs++;return "BAD";},now);Check(runs==0,"replayed interrupted job");});
        Test("duplicate completed and older sequence never reexecute",()=>{var a=Agent();string wire=Wire(Job(3));int runs=0;Func<string,string,string> run=(x,p)=>{runs++;return "ok";};a.Handle(wire,run,now);a.FlushOutbox(w=>true);a.Handle(wire,run,now);a.Handle(Wire(Job(2)),run,now);Check(runs==1,"duplicate executed");});
        Test("same sequence different job ID rejects",()=>{var a=Agent();a.Handle(Wire(Job()),(x,p)=>"ok",now);a.FlushOutbox(w=>true);Throws<InputRejected>(()=>a.Handle(Wire(Job()),(x,p)=>"BAD",now));});
        Test("encrypted outbox persists on upload failure and retries",()=>{AgentState disk=null;var a=new AgentCore(c,device,AS(),s=>disk=Clone(s));a.Handle(Wire(Job()),(x,p)=>"ok",now);string before=a.State.Outbox;Throws<TransportFailure>(()=>a.FlushOutbox(w=>{throw new TransportFailure("network down");}));Check(disk.Outbox==before,"outbox lost");var restored=new AgentCore(c,device,disk,s=>{});int uploads=0;restored.FlushOutbox(w=>{uploads++;Check(w==before,"wire changed");return true;});Check(uploads==1&&restored.State.Outbox=="","retry failed");});
        Test("upload acknowledgement then journal failure cannot cause reexecution",()=>{AgentState disk=null;bool failSave=false;var a=new AgentCore(c,device,AS(),s=>{if(failSave)throw new IOException("disk failure after HTTP ack");disk=Clone(s);});a.Handle(Wire(Job()),(x,p)=>"ok",now);failSave=true;Throws<IOException>(()=>a.FlushOutbox(w=>true));Check(disk.Outbox!="","durable retry disappeared");var restored=new AgentCore(c,device,disk,s=>{});Check(restored.State.Status=="COMPLETED","completion journal lost");int uploads=0;restored.FlushOutbox(w=>{uploads++;return true;});Check(uploads==1,"retry not possible");});
        Test("controller verifies report and deduplicates final",()=>{var ctl=Controller();var a=Agent();a.Handle(ctl.Submit("health","",now),(x,p)=>"ok",now);string report=a.State.Outbox;Check(ctl.Receive(report),"first report ignored");Check(!ctl.Receive(report),"duplicate accepted");Check(ctl.State.PendingJob==""&&ctl.State.LastFinalSeq==1,"pending not released");Check(ctl.State.LastResult.Contains("NOT_INDEPENDENTLY_VERIFIED"),"acceptance conflated");});
        Test("report with wrong signer rejects",()=>{var ctl=Controller();ctl.Submit("health","",now);var d=c.Message("report");Throws<CryptographicException>(()=>ctl.Receive(Common.Seal(Common.Encode(d),attacker,recipient)));});
        Test("controller rejects authenticated report for wrong command",()=>{var ctl=Controller();ctl.Submit("health","",now);var a=Agent();a.Handle(Wire(Job()),(x,p)=>"ok",now);Throws<InvalidDataException>(()=>ctl.Receive(a.State.Outbox));});
        Test("oversized result capped and inherited password redacted",()=>{Common.Secrets=new[]{"SECRET_FIXTURE"};var a=Agent();a.Handle(Wire(Job()),(x,p)=>"SECRET_FIXTURE"+new string('x',40000),now);X509Certificate2 signer;var report=Common.Open(a.State.Outbox,recipient,device,out signer);Check(Common.S(report,"summary").Length<=Common.MaxSummary&&Common.S(report,"summary").EndsWith("[TRUNCATED]")&&!Common.S(report,"summary").Contains("SECRET_FIXTURE"),"summary bound/redaction failed");Common.Secrets=new string[0];});
        Test("state JSON missing fields does not reset counters",()=>{string path=Path.Combine(work,"missing-state.json");File.WriteAllText(path,"{\"Version\":1}");Throws<InvalidDataException>(()=>Program.Load<AgentState>(path));});
        Test("atomic journal readback / corrupt state stops",()=>{string path=Path.Combine(work,"journal.json");Common.Atomic(path,Common.Encode(AS()));var valid=Program.Load<AgentState>(path);valid.Validate(c,device.Thumbprint);File.WriteAllText(path,"not-json");Throws<ArgumentException>(()=>Program.Load<AgentState>(path));});
        Test("stop flush then explicit local restart retains sequence and resumes",()=>{var a=Agent();bool stop=a.Handle(Wire(Job(1,"stop")),(x,p)=>"stopping",now);Check(stop&&a.StopAwaitingUpload(),"stop was not pending");a.FlushOutbox(w=>true);var restored=new AgentCore(c,device,Clone(a.State),s=>{});Check(!restored.StopAwaitingUpload()&&restored.State.Seq==1,"restart remained permanently stopped");int runs=0;restored.Handle(Wire(Job(2)),(x,p)=>{runs++;return "ok";},now);Check(runs==1,"explicit restart cannot continue");});
        Test("self-update ends like stop: report uploaded before the agent exits, restart is not stuck",()=>{string job=Common.Encode(new Dictionary<string,object>{{"file","ragent-update.zip"},{"sha256",new string('a',64)}});var ctl=Controller();ctl.Submit("self-update",job,now);Throws<InvalidDataException>(()=>Controller().Submit("self-update","",now));var a=Agent();bool stop=a.Handle(Wire(Job(1,"self-update",job)),(x,p)=>"staged",now);Check(stop&&a.StopAwaitingUpload(),"self-update must stop after its report");a.FlushOutbox(w=>true);var restored=new AgentCore(c,device,Clone(a.State),s=>{});Check(!restored.StopAwaitingUpload()&&restored.State.Seq==1,"restart after a delivered self-update report must run normally");});
        Test("request/body oversize rejected before crypto",()=>Throws<InputRejected>(()=>Agent().Handle(new string('a',Common.MaxWire+1),(x,p)=>"BAD",now)));
        Test("actual CLI pairing submit receive outputs intact 4000-char JSON",()=>{string root=Path.Combine(work,Guid.NewGuid().ToString("N"));string enrollment=Path.Combine(work,"cli-enrollment.cms.b64.txt");Common.Atomic(enrollment,Enroll(device));Cli("controller-init",root);Cli("pair",root,enrollment,Common.Fingerprint(device));Cli("submit",root,"health");string wire=Common.Read(Path.Combine(root,"pending-inbox.cms.b64.txt"));var a=Agent();a.Handle(wire,(x,p)=>new string('x',4000),now);string report=Path.Combine(work,"cli-report.cms.b64.txt");Common.Atomic(report,a.State.Outbox);string output=Cli("receive",root,report);var parsed=Common.Decode(output);Check(Common.S(parsed,"summary").Length==4000,"CLI chopped JSON/summary");Common.Decode(Cli("status",root));});
        Test("real curl fixture: 404 idle, encrypted GET and multipart POST receipt",()=>{string wire=Wire(Job());string path=Path.Combine(work,"transport.cms.b64.txt");Common.Atomic(path,wire);var testConfig=new Config();HttpFixture(new[]{"missing",wire,"{\"attachments\":[{\"filename\":\"stored.cms.b64.txt\"}]}"},new[]{404,200,200},url=>{testConfig.BaseUrl=url;var t=new Transport(testConfig);Check(t.Poll()==null,"404 not idle");Check(t.Poll()==wire,"GET mismatch");Check(t.Upload(path,"fixture.cms.b64.txt").Contains("attachments"),"no upload receipt");},request=>{if(request.StartsWith("POST"))Check(request.Contains(wire)&&request.Contains("name=\"files\""),"multipart body mismatch");});});
        Test("local model HTTP fixture uses bounded token request and returns advice telemetry",()=>{string reply="{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"bounded advice\"}}],\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":2,\"total_tokens\":42}}";HttpFixture(new[]{reply},new[]{200},url=>{var result=Common.Decode(LocalActions.ExecuteAt("reason","test prompt",url,5000));Check((bool)result["advice_only"]&&Common.S(result,"content")=="bounded advice"&&Common.S(result,"finish_reason")=="stop","bad advisory result");Check(Common.N((Dictionary<string,object>)result["usage"],"total_tokens")==42,"missing model usage");},request=>{Check(request.Contains("\"max_tokens\":512")&&!request.Contains("\"tools\""),"unbounded or tool-enabled request");});});
        Test("constrained JSON mode sends response format without enabling tools",()=>{string reply="{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"{}\"}}]}";HttpFixture(new[]{reply},new[]{200},url=>{var result=Common.Decode(LocalActions.ExecuteAt("reason-json","Return JSON",url,5000));Check(Common.S(result,"finish_reason")=="length"&&Common.S(result,"mode")=="reason-json","finish reason lost");},request=>Check(request.Contains("\"response_format\":{\"type\":\"json_object\"}")&&!request.Contains("\"tools\""),"JSON constraint missing"));});
        Test("quoted long content remains valid bounded JSON with truncation flag",()=>{string reply=Common.Encode(new{choices=new[]{new{message=new{content=new string('"',3800)}}}});HttpFixture(new[]{reply},new[]{200},url=>{string result=LocalActions.ExecuteAt("reason","test",url,5000);Check(result.Length<=3900&&(bool)Common.Decode(result)["content_truncated"],"invalid truncation envelope");});});
        Test("all four credential variables are cleared and redacted",()=>{var old=Common.CredentialKeys.Select(k=>Environment.GetEnvironmentVariable(k)).ToArray();var secrets=Common.Secrets;try{foreach(string key in Common.CredentialKeys)Environment.SetEnvironmentVariable(key,"synthetic-"+key);Common.ClearCredentials();foreach(string key in Common.CredentialKeys)Check(Environment.GetEnvironmentVariable(key)==null&&Common.Safe("synthetic-"+key)=="[REDACTED]","credential scrub missing");}finally{for(int i=0;i<old.Length;i++)Environment.SetEnvironmentVariable(Common.CredentialKeys[i],old[i]);Common.Secrets=secrets;}});
        Test("JSON reason requires prompt while fixtures reject prompt payloads",()=>{var ctl=Controller();Throws<InvalidDataException>(()=>ctl.Submit("reason-json","",now));Throws<InvalidDataException>(()=>ctl.Submit("fixture-roundtrip","arbitrary input",now));Check(AgentCore.ActionAllowed("fixture-roundtrip")&&AgentCore.ActionAllowed("fixture-break"),"fixture not allowed");});
        FixtureTests.Run(work,Test);
        SqlTests.Run(work,Test);
        HostTests.Run(work,Test);
        UpdaterTests.Run(work,Test);
        Test("local model HTTP response byte bound is enforced",()=>HttpFixture(new[]{new string('x',66000)},new[]{200},url=>Throws<InvalidDataException>(()=>LocalActions.ExecuteAt("health","",url,5000))));
        Test("UTF8 BOM state file parses without resetting sequence",()=>{string path=Path.Combine(work,"bom-state.json");var state=AS();state.Seq=7;state.LastJob=Guid.NewGuid().ToString();state.Status="COMPLETED";File.WriteAllText(path,Common.Encode(state),new UTF8Encoding(true));var parsed=Program.Load<AgentState>(path);parsed.Validate(c,device.Thumbprint);Check(parsed.Seq==7,"BOM lost sequence");});
        Test("report signing failure escapes rejection handler after action",()=>{AgentState disk=null;int runs=0;var a=new AgentCore(c,device,AS(),s=>disk=Clone(s));bool threw=false;try{a.Handle(Wire(Job()),(x,p)=>{runs++;typeof(AgentCore).GetField("device",BindingFlags.NonPublic|BindingFlags.Instance).SetValue(a,new X509Certificate2(device.RawData));return "ok";},now);}catch(Exception e){Check(!(e is InputRejected),"signing failure misclassified as untrusted input");threw=true;}Check(threw&&runs==1&&disk.Status=="RUNNING","failure was hidden or durable state advanced");});
        Test("exclusive journal file lock blocks second process and releases on death",()=>{string root=Path.Combine(work,"lock-fixture");Directory.CreateDirectory(root);var psi=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--hold-lock "+Common.Q(root)){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};using(var holder=Process.Start(psi)){try{Check(holder.StandardOutput.ReadLine()=="LOCKED","first process failed to acquire");var checkPsi=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--try-lock "+Common.Q(root)){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};using(var second=Process.Start(checkPsi)){Check(second.WaitForExit(5000)&&second.ExitCode==5,"second process acquired lock");}holder.Kill();holder.WaitForExit();using(var third=Process.Start(checkPsi)){Check(third.WaitForExit(5000)&&third.ExitCode==0,"lock not released on process death");}}finally{if(!holder.HasExited)holder.Kill();}}});
        // ---- v2 (2026-09-29): read-only file tools, heartbeat, sentinel polling ----
        string froot=Path.Combine(work,"ro-"+Guid.NewGuid().ToString("N"));string inside=Path.Combine(froot,"inside");string outside=Path.Combine(froot,"outside");Directory.CreateDirectory(inside);Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(inside,"cb.csv"),"a,b\n1,2\nSECRET_CONTENT_MARKER\n");File.WriteAllText(Path.Combine(outside,"secret.txt"),"SECRET_CONTENT_MARKER");
        for(int i=0;i<250;i++)File.WriteAllText(Path.Combine(inside,"log_"+i.ToString("D3")+".log"),"x");
        string rootsFile=Path.Combine(froot,"readonly-roots.txt");Func<string,string> P=p=>Common.Encode(new Dictionary<string,object>{{"path",p}});
        Test("file actions disabled until roots file exists",()=>{ReadOnlyFiles.RootsFile=Path.Combine(froot,"missing-roots.txt");Throws<InvalidOperationException>(()=>ReadOnlyFiles.Execute("file-info",P(inside)));});
        File.WriteAllText(rootsFile,"# test roots\r\n"+inside+"\r\n");ReadOnlyFiles.RootsFile=rootsFile;
        Test("file-info returns metadata and line count, never content",()=>{string r=LocalActions.Execute("file-info",P(Path.Combine(inside,"cb.csv")));var d=Common.Decode(r);Check(Common.N(d,"lines")==3&&(bool)d["ends_with_newline"]&&!r.Contains("SECRET_CONTENT_MARKER"),"bad file-info: "+r);});
        Test("list-dir caps entries, keeps envelope bound and flags truncation",()=>{string r=ReadOnlyFiles.Execute("list-dir",Common.Encode(new Dictionary<string,object>{{"path",inside},{"pattern","*.log"}}));var d=Common.Decode(r);Check(r.Length<=Common.MaxResult&&Common.N(d,"total")==250&&(bool)d["truncated"]&&((object[])d["items"]).Length<=200,"bad listing");});
        Test("file-hash matches independent SHA256",()=>{string f=Path.Combine(inside,"cb.csv");var d=Common.Decode(ReadOnlyFiles.Execute("file-hash",P(f)));Check(Common.S(d,"sha256")==Common.Hash(File.ReadAllBytes(f)),"hash mismatch");});
        Test("paths outside roots and dot-dot traversal are refused",()=>{Throws<UnauthorizedAccessException>(()=>ReadOnlyFiles.Execute("file-info",P(Path.Combine(outside,"secret.txt"))));Throws<UnauthorizedAccessException>(()=>ReadOnlyFiles.Execute("file-hash",P(inside+"\\..\\outside\\secret.txt")));Throws<UnauthorizedAccessException>(()=>ReadOnlyFiles.Execute("list-dir",P(froot)));});
        Test("junction inside a root is not followed",()=>{string link=Path.Combine(inside,"escape");var psi=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(link)+" "+Common.Q(outside)){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi))p.WaitForExit();Check(Directory.Exists(link),"fixture could not create junction");Throws<UnauthorizedAccessException>(()=>ReadOnlyFiles.Execute("file-info",P(Path.Combine(link,"secret.txt"))));Throws<UnauthorizedAccessException>(()=>ReadOnlyFiles.Execute("list-dir",P(link)));Directory.Delete(link);});
        Test("wildcards, bad patterns and extra fields are rejected",()=>{Throws<InvalidDataException>(()=>ReadOnlyFiles.Execute("file-info",P(inside+"\\*.csv")));Throws<InvalidDataException>(()=>ReadOnlyFiles.Execute("list-dir",Common.Encode(new Dictionary<string,object>{{"path",inside},{"pattern","..\\*"}})));Throws<InvalidDataException>(()=>ReadOnlyFiles.Execute("file-info",Common.Encode(new Dictionary<string,object>{{"path",inside},{"exec","x"}})));});
        Test("file actions go through the signed job path and require a prompt",()=>{var ctl=Controller();Throws<InvalidDataException>(()=>ctl.Submit("file-info","",now));var a=Agent();a.Handle(Wire(Job(1,"file-info",P(Path.Combine(inside,"cb.csv")))),LocalActions.Execute,now);X509Certificate2 s;var report=Common.Open(a.State.Outbox,recipient,device,out s);Check(Common.S(report,"executionState")=="COMPLETED"&&Common.S(report,"summary").Contains("\"lines\":3")&&!Common.S(report,"summary").Contains("SECRET_CONTENT_MARKER"),"file job report wrong");});
        Test("outside-root file job completes as FAILED without leaking",()=>{var a=Agent();a.Handle(Wire(Job(1,"file-hash",P(Path.Combine(outside,"secret.txt")))),LocalActions.Execute,now);X509Certificate2 s;var report=Common.Open(a.State.Outbox,recipient,device,out s);Check(Common.S(report,"executionState")=="FAILED"&&!Common.S(report,"summary").Contains("SECRET_CONTENT_MARKER"),"outside root not failed");});
        Test("heartbeat seals, verifies with pinned device, and rejects other kinds or signers",()=>{var a=Agent();string hb=Heartbeat.Build(c,device,a.State,now,"{\"status\":\"ok\"}");var d=Heartbeat.Verify(c,hb,recipient,device);Check(Common.S(d,"agentVersion")==Common.AgentVersion&&Common.S(d,"kind")=="heartbeat","heartbeat fields");Throws<CryptographicException>(()=>Heartbeat.Verify(c,Heartbeat.Build(c,attacker,a.State,now,"x"),recipient,device));a.Handle(Wire(Job()),(x,p)=>"ok",now);Throws<InvalidDataException>(()=>Heartbeat.Verify(c,a.State.Outbox,recipient,device));});
        Test("heartbeat cannot be accepted as a job report",()=>{var ctl=Controller();ctl.Submit("health","",now);Throws<InvalidDataException>(()=>ctl.Receive(Heartbeat.Build(c,device,AS(),now,"ok")));});
        Test("sentinel poll: 2 s inside wake window, 10 s otherwise",()=>{Check(Program.PollDelay(DateTime.UtcNow.AddMinutes(1))==2000&&Program.PollDelay(DateTime.MinValue)==10000,"poll delay");});
        Test("model probe never throws when model is down",()=>{Check(LocalActions.Probe("http://127.0.0.1:1").StartsWith("unreachable"),"probe threw or lied");});
        ReadOnlyFiles.RootsFile=null;
        // ---- v3 (2026-09-30): doc-qa local document Q&A ----
        Func<string> docQaRoot=()=>{
            string root=Path.Combine(work,"docqa-"+Guid.NewGuid().ToString("N"));string dir=Path.Combine(root,"doc-index","testidx");Directory.CreateDirectory(dir);
            var meta=new Dictionary<string,object>{{"doc_no","T"},{"title","測試規章"},{"doc_type",null},{"level",null},{"version",null},{"status",null},{"publish_date",null},{"effective_date",null},{"repealed_date",null},{"owner",null},{"synthetic",false}};
            var chunks=new object[]{
                new Dictionary<string,object>{{"chunk_id","T#01"},{"doc_id","T"},{"section","一般規定"},{"text","逾期未結案應於三日內處理。"},{"metadata",meta},{"source_file","t.md"}},
                new Dictionary<string,object>{{"chunk_id","T#02"},{"doc_id","T"},{"section","例外"},{"text","例外情形另行公告。"},{"metadata",meta},{"source_file","t.md"}},
            };
            File.WriteAllText(Path.Combine(dir,"chunks.json"),Common.Json().Serialize(chunks),new UTF8Encoding(false));
            using(var fs=new FileStream(Path.Combine(dir,"vectors.bin"),FileMode.Create,FileAccess.Write))using(var bw=new BinaryWriter(fs)){bw.Write(1f);bw.Write(0f);bw.Write(0f);bw.Write(1f);}
            return root;
        };
        Func<string,string> docQaPrompt=q=>Common.Encode(new Dictionary<string,object>{{"question",q},{"index","testidx"},{"as_of","2026-09-30"}});
        string embedResp=Common.Encode(new{data=new[]{new{index=0,embedding=new[]{1.0,0.0}}}});
        string rerankResp=Common.Encode(new{results=new[]{new{index=0,relevance_score=0.9},new{index=1,relevance_score=0.1}}});
        Test("doc-qa prompt keys are whitelisted",()=>Throws<InvalidDataException>(()=>DocQa.Execute(work,Common.Encode(new Dictionary<string,object>{{"question","test"},{"index","synthetic"},{"extra","x"}}))));
        Test("doc-qa question length bounds enforced",()=>{Throws<InvalidDataException>(()=>DocQa.Execute(work,Common.Encode(new Dictionary<string,object>{{"question",""},{"index","synthetic"}})));Throws<InvalidDataException>(()=>DocQa.Execute(work,Common.Encode(new Dictionary<string,object>{{"question",new string('a',501)},{"index","synthetic"}})));});
        Test("doc-qa index name must match pattern",()=>Throws<InvalidDataException>(()=>DocQa.Execute(work,Common.Encode(new Dictionary<string,object>{{"question","q"},{"index","Bad Index!"}}))));
        Test("doc-qa is allow-listed and requires a nonempty prompt",()=>{Check(AgentCore.ActionAllowed("doc-qa")&&AgentCore.UsesPrompt("doc-qa"),"doc-qa not wired into the job whitelist");var ctl=Controller();Throws<InvalidDataException>(()=>ctl.Submit("doc-qa","",now));});
        Test("doc-qa retrieves, cites, repairs once, and cleans up chunk_id citation syntax",()=>{
            string root=docQaRoot();
            string chat1=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="這是沒有引用也沒有狀態的回答"}}}});
            string chat2=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="依規定應於三日內完成 [chunk_id: T#01] 處理。\nSTATUS: ANSWER"}}}});
            HttpFixture(new[]{embedResp,rerankResp,chat1,chat2},new[]{200,200,200,200},url=>{
                string result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);
                var d=Common.Decode(result);
                Check(Common.S(d,"kind")=="doc_answer"&&(bool)d["advice_only"]&&Common.S(d,"status")=="ANSWER"&&(bool)d["repaired"],"doc-qa result missing expected fields: "+result);
                Check(Common.S(d,"answer").Contains("[T#01]")&&!Common.S(d,"answer").Contains("chunk_id"),"citation not cleaned up: "+result);
                var sources=(object[])d["sources"];Check(sources.Length==1,"expected exactly one cited source");
                var src=(Dictionary<string,object>)sources[0];Check(Common.S(src,"chunk_id")=="T#01"&&Common.S(src,"source_file")=="t.md","source metadata wrong: "+result);
                Check(((object[])d["remaining_issues"]).Length==0,"repaired answer still flagged: "+result);
                Check(result.Length<=3900,"doc-qa output exceeds bound");
            });
        });
        Test("doc-qa output over 3900 chars is truncated with answer_truncated flag",()=>{
            string root=docQaRoot();
            string longChat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="依規定應於三日內完成 [T#01] 處理，"+new string('補',4000)+"\nSTATUS: ANSWER"}}}});
            HttpFixture(new[]{embedResp,rerankResp,longChat},new[]{200,200,200},url=>{
                string result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);
                Check(result.Length<=3900,"not truncated to bound: len="+result.Length);
                var d=Common.Decode(result);Check((bool)d["answer_truncated"],"missing truncation flag: "+result);
            });
        });
        // 2026-09-30：追問（history）— 格式檢查，以及前面的提問有帶進檢索、對話紀錄有帶進提示詞
        Func<object[],string> histPrompt=h=>Common.Encode(new Dictionary<string,object>{{"question","那舊版呢？"},{"index","testidx"},{"as_of","2026-09-30"},{"history",h}});
        Test("doc-qa history format is validated",()=>{
            Throws<InvalidDataException>(()=>DocQa.Execute(work,histPrompt(new object[]{new Dictionary<string,object>{{"role","system"},{"content","x"}}})));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,histPrompt(new object[]{new Dictionary<string,object>{{"role","user"},{"content","x"},{"extra","y"}}})));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,histPrompt(Enumerable.Range(0,DocQa.MaxHistoryTurns+1).Select(i=>(object)new Dictionary<string,object>{{"role","user"},{"content","q"+i}}).ToArray())));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,histPrompt(new object[]{new Dictionary<string,object>{{"role","user"},{"content",new string('a',DocQa.MaxHistoryChars+1)}}})));
        });
        Test("doc-qa history reaches retrieval query and answer prompt",()=>{
            string root=docQaRoot(); var seen=new List<string>();
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="舊版門檻見 [T#01]。\nSTATUS: ANSWER"}}}});
            var h=new object[]{new Dictionary<string,object>{{"role","user"},{"content","限額辦法 v4 的預警門檻是多少？"}},new Dictionary<string,object>{{"role","assistant"},{"content","v4 是 85% [T#01]。"}}};
            HttpFixture(new[]{embedResp,rerankResp,chat},new[]{200,200,200},url=>{
                string result=DocQa.ExecuteAt(root,histPrompt(h),url,url,url,5000,5000,5000);
                Check(Common.S(Common.Decode(result),"status")=="ANSWER","history answer failed: "+result);
            },body=>seen.Add(body??""));
            Check(seen.Count>=3,"expected embed, rerank and chat requests, saw "+seen.Count);
            Check(seen[0].Contains("限額辦法 v4 的預警門檻是多少？")&&seen[0].Contains("那舊版呢？"),"embedding query lacks the prior user turn: "+seen[0]);
            Check(seen[1].Contains("限額辦法 v4 的預警門檻是多少？"),"rerank query lacks the prior user turn");
            Check(seen[2].Contains("對話紀錄")&&seen[2].Contains("assistant: v4 是 85%"),"answer prompt lacks the history block");
        });
        // 2026-09-30：逐字核對（Grounding.cs）— 和 Node lib/grounding.cjs 逐題結果一致；grounding-parity.json 由 make-grounding-parity.cjs 產生
        Test("grounding check matches the Node reference on every parity case",()=>{
            string file=Path.Combine(Path.GetDirectoryName(Path.GetFullPath(work)),"grounding-parity.json");
            var fixture=(Dictionary<string,object>)new System.Web.Script.Serialization.JavaScriptSerializer{MaxJsonLength=int.MaxValue}.DeserializeObject(File.ReadAllText(file,Encoding.UTF8));
            var texts=(Dictionary<string,object>)fixture["texts"];var cases=(object[])fixture["cases"];Func<object,List<string>> strs=o=>((object[])o).Cast<string>().ToList();
            var bad=new List<string>();
            foreach(Dictionary<string,object> k in cases){
                List<string> red,yellow;Grounding.Check((string)k["answer"],strs(k["cited"]).Select(id=>(string)texts[id]),strs(k["visible"]).Select(id=>(string)texts[id]),(string)k["extra"],out red,out yellow);
                if(!red.SequenceEqual(strs(k["red"]))||!yellow.SequenceEqual(strs(k["yellow"])))bad.Add(k["name"]+": red="+string.Join("|",red)+" yellow="+string.Join("|",yellow)+" expected red="+string.Join("|",strs(k["red"]))+" yellow="+string.Join("|",strs(k["yellow"])));
            }
            Check(cases.Length>=100,"parity fixture too small: "+cases.Length);
            Check(bad.Count==0,bad.Count+" mismatch(es): "+string.Join(" ;; ",bad.Take(5)));
        });
        // 2026-10-01：沒有標題的 .txt／.docx 依「第X條」切段、依行打包 — 和 Node lib/chunk.cjs 一致；chunk-parity.json 由 make-chunk-parity.cjs 產生
        Test("generic chunking (articles, line packing) matches the Node reference",()=>{
            string file=Path.Combine(Path.GetDirectoryName(Path.GetFullPath(work)),"chunk-parity.json");
            var fixture=(Dictionary<string,object>)new System.Web.Script.Serialization.JavaScriptSerializer{MaxJsonLength=int.MaxValue}.DeserializeObject(File.ReadAllText(file,Encoding.UTF8));
            var bad=new List<string>();var all=(object[])fixture["cases"];
            foreach(Dictionary<string,object> k in all){
                var got=DocQa.ChunkGeneric((string)k["text"],(string)k["docId"],(string)k["title"]);
                var exp=((object[])k["chunks"]).Cast<Dictionary<string,object>>().ToList();
                bool same=got.Count==exp.Count;
                for(int ci=0;same&&ci<got.Count;ci++)same=(string)got[ci]["chunk_id"]==(string)exp[ci]["chunk_id"]&&(string)got[ci]["section"]==(string)exp[ci]["section"]&&(string)got[ci]["text"]==(string)exp[ci]["text"];
                if(!same)bad.Add(k["name"]+": got "+string.Join(" | ",got.Select(cx=>cx["section"]+"("+((string)cx["text"]).Length+")")));
            }
            Check(all.Length>=6,"chunk parity fixture too small");
            Check(bad.Count==0,string.Join(" ;; ",bad));
            var reg=DocQa.ChunkGeneric((string)((Dictionary<string,object>)all[0])["text"],"rules-a","t");
            Check(reg.Any(cx=>(string)cx["section"]=="第四條之一 例外核准")&&!reg.Any(cx=>((string)cx["section"]).StartsWith("第七條")),"article split wrong: "+string.Join(" | ",reg.Select(cx=>cx["section"])));
            var law=DocQa.ChunkGeneric("第 1 條 目的\n為規範…訂定本辦法。\n第 2 條 定義\n本辦法用詞定義如下。\n第 2-1 條 例外\n第七條、第八條之規定，於本條準用之。\n第 3 條 施行\n本辦法自發布日施行。","lawdb","法規");
            Check(string.Join("|",law.Select(cx=>cx["section"]))=="第1條 目的|第2條 定義|第2-1條 例外|第3條 施行","law-database numbering or an in-text 第七條、 line split wrong: "+string.Join(" | ",law.Select(cx=>cx["section"])));
            var dx=(object[])fixture["docx_cases"];var badDocx=new List<string>();
            foreach(Dictionary<string,object> k in dx){
                byte[] doc;using(var ms=new MemoryStream()){using(var z=new System.IO.Compression.ZipArchive(ms,System.IO.Compression.ZipArchiveMode.Create,true)){var en=z.CreateEntry("word/document.xml");using(var w=new StreamWriter(en.Open(),new UTF8Encoding(false)))w.Write((string)k["xml"]);}doc=ms.ToArray();}
                string got=DocQa.ExtractDocxText(doc);if(got!=(string)k["text"])badDocx.Add(k["name"]+": "+got.Replace("\n","\\n"));
            }
            Check(dx.Length>=2&&badDocx.Count==0,"docx text differs from Node: "+string.Join(" ;; ",badDocx));
        });
        Test("doc-qa flags numbers missing from the cited passage (unsupported / cited_elsewhere)",()=>{
            string root=docQaRoot();
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="逾期應於 3 日內處理，並於 5 個營業日內回報 [T#02]。\nSTATUS: ANSWER"}}}});
            HttpFixture(new[]{embedResp,rerankResp,chat},new[]{200,200,200},url=>{
                string result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);
                var d=Common.Decode(result);
                Check(((object[])d["unsupported"]).Cast<string>().SequenceEqual(new[]{"5個營業日"}),"unsupported wrong: "+result);
                Check(((object[])d["cited_elsewhere"]).Cast<string>().SequenceEqual(new[]{"3日"}),"cited_elsewhere wrong: "+result);
                Check(((object[])d["visible"]).Cast<string>().SequenceEqual(new[]{"T#01","T#02"})&&Convert.ToDouble(d["rerank_top"])==0.9,"visible/rerank_top wrong: "+result);
            });
        });
        // ---- v3.1 (2026-09-30): 字數上限 1024、只補 STATUS 行、程式修格式 ----
        Test("doc-qa asks only for the STATUS line when a complete answer lacks it",()=>{
            string root=docQaRoot();var seen=new List<string>();
            string chat1=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="依規定應於三日內完成（T#01）處理。"}}}});
            string chat2=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="STATUS: ANSWER"}}}});
            string result=null;HttpFixture(new[]{embedResp,rerankResp,chat1,chat2},new[]{200,200,200,200},url=>{result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);},body=>seen.Add(body??""));
            var d=Common.Decode(result);
            Check(seen.Count==4&&seen[2].Contains("\"max_tokens\":1024")&&seen[3].Contains("\"max_tokens\":16")&&seen[3].Contains("少了最後的 STATUS 行"),"expected a 1024-token answer and a 16-token STATUS follow-up");
            Check(Common.S(d,"status")=="ANSWER"&&Common.S(d,"repair_kind")=="status_line"&&Common.S(d,"answer").Contains("[T#01]")&&((object[])d["remaining_issues"]).Length==0,"status-line fix wrong: "+result);
        });
        Test("a NO_INFO answer without citations is accepted without a rewrite",()=>{
            string root=docQaRoot();var seen=new List<string>();
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="資料中沒有提到期貨選擇權的 Delta 限額。\n\nSTATUS: NO_INFO"}}}});
            string result=null;HttpFixture(new[]{embedResp,rerankResp,chat},new[]{200,200,200},url=>{result=DocQa.ExecuteAt(root,docQaPrompt("Delta 限額是多少？"),url,url,url,5000,5000,5000);},body=>seen.Add(body??""));
            var d=Common.Decode(result);Check(seen.Count==3&&Common.S(d,"status")=="NO_INFO"&&!(bool)d["repaired"]&&((object[])d["remaining_issues"]).Length==0,"NO_INFO without citation should pass: "+result);
        });
        Test("doc-qa rewrites the whole answer when it was cut off",()=>{
            string root=docQaRoot();var seen=new List<string>();
            string chat1=Common.Encode(new{choices=new[]{new{finish_reason="length",message=new{content="依規定應於三日內完成 [T#01] 處理，且"}}}});
            string chat2=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="依規定應於三日內完成 [T#01] 處理。\nSTATUS: ANSWER"}}}});
            string result=null;HttpFixture(new[]{embedResp,rerankResp,chat1,chat2},new[]{200,200,200,200},url=>{result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);},body=>seen.Add(body??""));
            Check(seen.Count==4&&seen[3].Contains("\"max_tokens\":1024")&&seen[3].Contains("重寫完整答案"),"expected a full rewrite");
            Check(Common.S(Common.Decode(result),"repair_kind")=="rewrite","repair kind wrong: "+result);
        });
        Test("doc-qa answers a repeated question from the cache and misses on any change",()=>{
            string root=docQaRoot();string mf=Path.Combine(root,"doc-index","testidx","manifest.json");File.WriteAllText(mf,"{\"schema\":\"docqa_index_v1\",\"created_utc\":\"2026-09-30T00:00:00Z\"}",new UTF8Encoding(false));
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="依規定應於三日內完成 [T#01] 處理。\nSTATUS: ANSWER"}}}});
            string propsA=Common.Encode(new{model_path="C:/models/Qwen3.5-4B-Q4_0.gguf"}),propsB=Common.Encode(new{model_path="C:/models/Qwen3.5-9B-Q4_0.gguf"});
            string propsE=Common.Encode(new{model_path="C:/models/embed.gguf"}),propsR=Common.Encode(new{model_path="C:/models/rerank.gguf"});
            string first=null;HttpFixture(new[]{propsA,propsE,propsR,embedResp,rerankResp,chat},new[]{200,200,200,200,200,200},url=>{first=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);});
            string dead="http://127.0.0.1:1";
            // 假伺服器只回三個模型身分；命中快取就不會再發請求，沒命中會卡在嵌入而逾時失敗
            Func<string,string,string> onlyProps=(chatProps,prompt)=>{string res=null;HttpFixture(new[]{chatProps,propsE,propsR},new[]{200,200,200},url=>{res=DocQa.ExecuteAt(root,prompt,url,url,url,1000,1000,1000);});return res;};
            var hit=Common.Decode(onlyProps(propsA,docQaPrompt("逾期案件何時要處理？")));
            Check((bool)hit["cached"]&&Common.S(hit,"answer")==Common.S(Common.Decode(first),"answer"),"second identical question was not served from the cache");
            Throws<WebException>(()=>onlyProps(propsA,Common.Encode(new Dictionary<string,object>{{"question","逾期案件何時要處理？"},{"index","testidx"},{"as_of","2026-10-01"}})));
            Throws<WebException>(()=>onlyProps(propsA,Common.Encode(new Dictionary<string,object>{{"question","逾期案件何時要處理？"},{"index","testidx"},{"as_of","2026-09-30"},{"history",new object[]{new Dictionary<string,object>{{"role","user"},{"content","前一題"}}}}})));
            Throws<WebException>(()=>onlyProps(propsB,docQaPrompt("逾期案件何時要處理？")));   // 換模型
            Throws<WebException>(()=>DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),dead,dead,dead,1000,1000,1000));   // 取不到模型身分就不用快取
            // 快取檔被改過（簽章對不上）就不採用
            string cacheDir=Path.Combine(root,"doc-cache","testidx"),cf=Directory.GetFiles(cacheDir,"*.json")[0],orig=File.ReadAllText(cf,Encoding.UTF8);
            File.WriteAllText(cf,orig.Replace("三日","十日"),new UTF8Encoding(false));
            Throws<WebException>(()=>onlyProps(propsA,docQaPrompt("逾期案件何時要處理？")));
            File.WriteAllText(cf,orig,new UTF8Encoding(false));
            Check((bool)Common.Decode(onlyProps(propsA,docQaPrompt("逾期案件何時要處理？")))["cached"],"restored cache entry should hit again");
            // 快取資料夾換成交接點（指向同一份有效快取）也不用
            Directory.Move(cacheDir,cacheDir+"-real");var psj=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(cacheDir)+" "+Common.Q(cacheDir+"-real")){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psj))p.WaitForExit();
            Check(Directory.Exists(cacheDir),"fixture could not create junction");
            // 跳過快取時連模型身分都不查，假伺服器的回應會被當成嵌入結果而失敗；若沒擋交接點，這裡會命中快取並正常回傳
            bool servedFromJunction=true;try{onlyProps(propsA,docQaPrompt("逾期案件何時要處理？"));}catch(Exception){servedFromJunction=false;}
            Check(!servedFromJunction,"a junctioned cache folder must not be used");
            Directory.Delete(cacheDir);Directory.Move(cacheDir+"-real",cacheDir);
            File.WriteAllText(mf,"{\"schema\":\"docqa_index_v1\",\"created_utc\":\"2026-10-01T00:00:00Z\"}",new UTF8Encoding(false));
            Throws<WebException>(()=>onlyProps(propsA,docQaPrompt("逾期案件何時要處理？")));   // 索引重建
        });
        Test("doc-qa search queries are validated",()=>{
            Func<object,string> withQ=q=>Common.Encode(new Dictionary<string,object>{{"question","q"},{"index","testidx"},{"queries",q}});
            Throws<InvalidDataException>(()=>DocQa.Execute(work,withQ("not an array")));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,withQ(new object[]{"a","b","c","d"})));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,withQ(new object[]{"  "})));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,withQ(new object[]{new string('字',DocQa.MaxQueryChars+1)})));
            Throws<InvalidDataException>(()=>DocQa.Execute(work,withQ(new object[]{5})));
        });
        Test("doc-qa merges the brain's search queries round-robin and still answers the original question",()=>{
            string root=Path.Combine(work,"docqa-q-"+Guid.NewGuid().ToString("N"));string dir=Path.Combine(root,"doc-index","testidx");Directory.CreateDirectory(dir);
            var meta=new Dictionary<string,object>{{"doc_no","T"},{"title","測試"},{"doc_type",null},{"level",null},{"version",null},{"status",null},{"publish_date",null},{"effective_date",null},{"repealed_date",null},{"owner",null},{"synthetic",false}};
            var chunks=Enumerable.Range(1,8).Select(i=>(object)new Dictionary<string,object>{{"chunk_id","T#0"+i},{"doc_id","T"},{"section","節"+i},{"text","內容"+i},{"metadata",meta},{"source_file","t.md"}}).ToArray();
            File.WriteAllText(Path.Combine(dir,"chunks.json"),Common.Json().Serialize(chunks),new UTF8Encoding(false));
            using(var fs=new FileStream(Path.Combine(dir,"vectors.bin"),FileMode.Create,FileAccess.Write))using(var bw=new BinaryWriter(fs))for(int i=0;i<8;i++){bw.Write(1f);bw.Write(0f);}
            string emb=Common.Encode(new{data=new[]{new{index=0,embedding=new[]{1.0,0.0}}}});
            string rrUp=Common.Encode(new{results=Enumerable.Range(0,8).Select(i=>new{index=i,relevance_score=0.9-i*0.1}).ToArray()});      // 原題：第 1 段最高
            string rrDown=Common.Encode(new{results=Enumerable.Range(0,8).Select(i=>new{index=7-i,relevance_score=0.9-i*0.1}).ToArray()}); // 改寫查詢：第 8 段最高
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content="答案 [T#01]。\nSTATUS: ANSWER"}}}});
            var seen=new List<string>();string result=null;
            string prompt=Common.Encode(new Dictionary<string,object>{{"question","原本的問題？"},{"index","testidx"},{"as_of","2026-09-30"},{"queries",new object[]{"改寫的查詢"}}});
            HttpFixture(new[]{emb,rrUp,emb,rrDown,chat},new[]{200,200,200,200,200},url=>{result=DocQa.ExecuteAt(root,prompt,url,url,url,5000,5000,5000);},body=>seen.Add(body??""));
            var vis=((object[])Common.Decode(result)["visible"]).Cast<string>().ToList();
            Check(vis.SequenceEqual(new[]{"T#01","T#08","T#02","T#07","T#03","T#06"}),"round-robin order wrong: "+string.Join(",",vis));
            Check(seen.Count==5&&seen[2].Contains("改寫的查詢")&&seen[4].Contains("原本的問題？")&&!seen[4].Contains("改寫的查詢"),"answer prompt must use the original question only");
        });
        Test("format fixer repairs citation variants only for visible chunks",()=>{
            var vis=new List<string>{"A#01","B#02"};
            Check(DocQa.FixFormat("見（A#01）與 [MAP:B#02]、[A#01, B#02]。\n**STATUS: answer**。",vis)=="見[A#01]與 [B#02]、[A#01][B#02]。\n\nSTATUS: ANSWER","fix wrong: "+DocQa.FixFormat("見（A#01）與 [MAP:B#02]、[A#01, B#02]。\n**STATUS: answer**。",vis));
            Check(DocQa.FixFormat("見 (Z#09) 與 [MAP:POL-X]。\nSTATUS: ANSWER",vis)=="見 (Z#09) 與 [MAP:POL-X]。\nSTATUS: ANSWER","unknown ids must stay untouched");
            Check(DocQa.StatusFromReply("status：no_info")=="STATUS: NO_INFO"&&DocQa.StatusFromReply("我覺得是 ANSWER")==null,"status reply parsing wrong");
        });
        Test("format fixer matches the Node reference on every parity case",()=>{
            string file=Path.Combine(Path.GetDirectoryName(Path.GetFullPath(work)),"format-fix-parity.json");
            var fx=(Dictionary<string,object>)new System.Web.Script.Serialization.JavaScriptSerializer{MaxJsonLength=int.MaxValue}.DeserializeObject(File.ReadAllText(file,Encoding.UTF8));
            var bad=new List<string>();
            foreach(Dictionary<string,object> k in (object[])fx["cases"]){string got=DocQa.FixFormat((string)k["text"],((object[])k["visible"]).Cast<string>().ToList());if(got!=(string)k["expected"])bad.Add((string)k["name"]);}
            foreach(Dictionary<string,object> k in (object[])fx["replies"]){string got=DocQa.StatusFromReply((string)k["reply"]);if(got!=(k["expected"] as string))bad.Add("reply:"+k["reply"]);}
            Check(((object[])fx["cases"]).Length>=40,"parity fixture too small");
            Check(bad.Count==0,bad.Count+" mismatch(es): "+string.Join(" ;; ",bad.Take(5)));
        });
        // ---- v3.1 (2026-09-30): remote doc-index / doc-list ----
        Test("doc-index and doc-list are allow-listed with the right prompt rules",()=>{
            Check(AgentCore.ActionAllowed("doc-index")&&AgentCore.ActionAllowed("doc-list")&&AgentCore.UsesPrompt("doc-index")&&!AgentCore.UsesPrompt("doc-list"),"whitelist wiring");
            Throws<InvalidDataException>(()=>Controller().Submit("doc-index","",now));Throws<InvalidDataException>(()=>Controller().Submit("doc-list","{}",now));
        });
        Func<string> docRoot=()=>{string r=Path.Combine(work,"didx-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(Path.Combine(r,"allowed"));Directory.CreateDirectory(Path.Combine(r,"outside"));
            File.WriteAllText(Path.Combine(r,"allowed","a.md"),"# A\n\n逾期未結案應於三日內處理。",new UTF8Encoding(false));File.WriteAllText(Path.Combine(r,"allowed","b.txt"),"例外情形另行公告。",new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(r,"outside","secret.md"),"SECRET_CONTENT_MARKER",new UTF8Encoding(false));return r;};
        Func<string,string,string> idxJson=(index,folder)=>Common.Encode(new Dictionary<string,object>{{"index",index},{"folder",folder}});
        // 和 RUNBOOK 的 icacls 相同：只留代理程式帳號、Administrators、SYSTEM
        Action<string> protect=f=>{var acl=new System.Security.AccessControl.FileSecurity();acl.SetAccessRuleProtection(true,false);
            foreach(var sid in new[]{System.Security.Principal.WindowsIdentity.GetCurrent().User.Value,"S-1-5-32-544","S-1-5-18"})acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(sid),System.Security.AccessControl.FileSystemRights.FullControl,System.Security.AccessControl.AccessControlType.Allow));
            File.SetAccessControl(f,acl);};
        Action<string,string> writeRoots=(r,allowed)=>{string f=Path.Combine(r,"doc-roots.txt");File.WriteAllText(f,allowed+"\r\n",new UTF8Encoding(false));protect(f);};
        Test("remote doc-index is disabled without doc-roots.txt",()=>{string r=docRoot();Throws<InvalidOperationException>(()=>DocQa.RemoteIndexAt(r,idxJson("t",Path.Combine(r,"allowed")),"http://127.0.0.1:1",1000));});
        Test("remote doc-index rejects outside folders, junctions, unknown fields and bad replace",()=>{
            string r=docRoot();writeRoots(r,Path.Combine(r,"allowed"));
            Throws<UnauthorizedAccessException>(()=>DocQa.RemoteIndexAt(r,idxJson("t",Path.Combine(r,"outside")),"http://127.0.0.1:1",1000));
            string link=Path.Combine(r,"allowed","jump");var psi=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(link)+" "+Common.Q(Path.Combine(r,"outside"))){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi))p.WaitForExit();
            Check(Directory.Exists(link),"fixture could not create junction");
            Throws<UnauthorizedAccessException>(()=>DocQa.RemoteIndexAt(r,idxJson("t",link),"http://127.0.0.1:1",1000));
            Throws<InvalidDataException>(()=>DocQa.RemoteIndexAt(r,Common.Encode(new Dictionary<string,object>{{"index","t"},{"folder",Path.Combine(r,"allowed")},{"exec","x"}}),"http://127.0.0.1:1",1000));
            Throws<InvalidDataException>(()=>DocQa.RemoteIndexAt(r,Common.Encode(new Dictionary<string,object>{{"index","t"},{"folder",Path.Combine(r,"allowed")},{"replace","yes"}}),"http://127.0.0.1:1",1000));
            Throws<InvalidDataException>(()=>DocQa.RemoteIndexAt(r,idxJson("Bad Name",Path.Combine(r,"allowed")),"http://127.0.0.1:1",1000));
            Directory.Delete(link);
        });
        Test("remote doc-index builds atomically, skips links, refuses silent overwrite, replaces on request, and doc-list reports it",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed");writeRoots(r,allowed);
            string link=Path.Combine(allowed,"jump");var psi=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(link)+" "+Common.Q(Path.Combine(r,"outside"))){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi))p.WaitForExit();
            string props=Common.Encode(new{model_path="C:/models/embed.gguf"});string emb=Common.Encode(new{data=new[]{new{index=0,embedding=new[]{1.0,0.0}},new{index=1,embedding=new[]{0.0,1.0}}}});
            string first=null;HttpFixture(new[]{props,emb},new[]{200,200},url=>{first=DocQa.RemoteIndexAt(r,idxJson("t2",allowed),url,5000);},body=>Check(!body.Contains("SECRET_CONTENT_MARKER"),"linked folder content was embedded"));
            var d=Common.Decode(first);Check(Common.N(d,"chunk_count")==2&&Common.N(d,"file_count")==2&&Common.N(d,"skipped_links")==1&&!(bool)d["replaced"],"first build wrong: "+first);
            Throws<InvalidOperationException>(()=>DocQa.RemoteIndexAt(r,idxJson("t2",allowed),"http://127.0.0.1:1",1000));
            string second=null;HttpFixture(new[]{props,emb},new[]{200,200},url=>{second=DocQa.RemoteIndexAt(r,Common.Encode(new Dictionary<string,object>{{"index","t2"},{"folder",allowed},{"replace",true}}),url,5000);});
            Check((bool)Common.Decode(second)["replaced"],"replace not reported: "+second);
            Check(!Directory.EnumerateDirectories(Path.Combine(r,"doc-index")).Any(x=>Path.GetFileName(x).StartsWith("~")),"temporary index folders left behind");
            var list=Common.Decode(DocQa.ListIndexes(r));var items=((object[])list["indexes"]).Cast<Dictionary<string,object>>().ToList();
            Check(items.Count==1&&Common.S(items[0],"index")=="t2"&&Convert.ToInt64(items[0]["chunk_count"])==2&&Convert.ToInt64(items[0]["file_count"])==2,"doc-list wrong: "+DocQa.ListIndexes(r));
            Directory.Delete(link);
        });
        // 2026-10-01：真實文件常混有 PDF／舊版 .doc → 建索引結果列出略過的類型；Word 開檔時的 ~$ 鎖定檔不算壞檔
        Test("doc-index reports unsupported file types and ignores Office lock files",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed");writeRoots(r,allowed);
            File.WriteAllBytes(Path.Combine(allowed,"c.pdf"),new byte[]{1,2,3});File.WriteAllBytes(Path.Combine(allowed,"d.PDF"),new byte[]{1});File.WriteAllBytes(Path.Combine(allowed,"e.doc"),new byte[]{1});
            File.WriteAllBytes(Path.Combine(allowed,"~$a.docx"),new byte[]{0,1,2,3,4});
            string props=Common.Encode(new{model_path="C:/models/embed.gguf"});string emb=Common.Encode(new{data=new[]{new{index=0,embedding=new[]{1.0,0.0}},new{index=1,embedding=new[]{0.0,1.0}}}});
            string res=null;HttpFixture(new[]{props,emb},new[]{200,200},url=>{res=DocQa.RemoteIndexAt(r,idxJson("t3",allowed),url,5000);});
            var d=Common.Decode(res);var un=(Dictionary<string,object>)d["skipped_unsupported"];
            Check(Common.N(d,"file_count")==2&&Common.N(d,"unreadable")==0&&Convert.ToInt64(un[".pdf"])==2&&Convert.ToInt64(un[".doc"])==1&&un.Count==2,"unsupported report wrong: "+res);
            string only=docRoot(),onlyAllowed=Path.Combine(only,"allowed");foreach(var fx in Directory.GetFiles(onlyAllowed))File.Delete(fx);
            File.WriteAllBytes(Path.Combine(onlyAllowed,"x.pdf"),new byte[]{1});writeRoots(only,onlyAllowed);
            string msg=null;try{DocQa.RemoteIndexAt(only,idxJson("t4",onlyAllowed),"http://127.0.0.1:1",1000);}catch(InvalidDataException ex2){msg=ex2.Message;}
            Check(msg!=null&&msg.Contains("found .pdf x1"),"only-PDF folder message wrong: "+msg);
        });
        // v3.1 安全審查後追加
        Test("doc-roots.txt writable by ordinary users disables remote doc-index",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed"),rf=Path.Combine(r,"doc-roots.txt");writeRoots(r,allowed);
            Throws<InvalidOperationException>(()=>DocQa.RemoteIndexAt(r,idxJson("t",allowed),"http://127.0.0.1:1",1000));   // 收緊後可用（連不到假的嵌入伺服器才失敗）
            var acl=File.GetAccessControl(rf);acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier("S-1-5-32-545"),System.Security.AccessControl.FileSystemRights.Write,System.Security.AccessControl.AccessControlType.Allow));File.SetAccessControl(rf,acl);
            Throws<UnauthorizedAccessException>(()=>DocQa.RemoteIndexAt(r,idxJson("t",allowed),"http://127.0.0.1:1",1000));
        });
        Test("set-doc-roots.cmd (v3.1 package) produces a roots file the agent accepts",()=>{
            string script=Path.GetFullPath(Path.Combine(work,"..","..","..","deploy_docqa_v3_20260930","v31","package","set-doc-roots.cmd"));
            if(!File.Exists(script)){Console.WriteLine("SKIP set-doc-roots.cmd not found");return;}
            string r=docRoot(),allowed=Path.Combine(r,"allowed"),amp=Path.Combine(r,"R&D 規章"),rf=Path.Combine(r,"doc-roots.txt");Directory.CreateDirectory(amp);
            var psi=new ProcessStartInfo("cmd.exe","/c \""+Common.Q(script)+" "+Common.Q(allowed)+" "+Common.Q(amp)+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};psi.EnvironmentVariables["DOCROOTS_FILE"]=rf;
            using(var p=Process.Start(psi)){p.StandardOutput.ReadToEnd();p.WaitForExit();Check(p.ExitCode==0,"set-doc-roots.cmd failed");}
            var roots=DocQa.ReadProtectedRoots(rf);
            Check(roots.Length==2&&roots.Contains(Path.GetFullPath(allowed))&&roots.Contains(Path.GetFullPath(amp)),"roots file wrong: "+string.Join(" | ",roots));
            var psi2=new ProcessStartInfo("cmd.exe","/c \""+Common.Q(script)+" "+Common.Q(allowed)+" "+Common.Q(Path.Combine(r,"missing"))+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};psi2.EnvironmentVariables["DOCROOTS_FILE"]=rf;
            using(var p=Process.Start(psi2)){p.StandardOutput.ReadToEnd();p.WaitForExit();Check(p.ExitCode!=0,"a missing folder must stop the script");}
            Check(DocQa.ReadProtectedRoots(rf).Length==2,"a failed run must not change the existing list");
        });
        Test("files reached through a junction or hard link are refused at read time",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed"),rootFinal=DocQa.FinalDirPath(allowed);
            Check(DocQa.ReadVerified(Path.Combine(allowed,"a.md"),rootFinal).Length>0,"normal file not readable");
            string link=Path.Combine(allowed,"jump");var psi=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(link)+" "+Common.Q(Path.Combine(r,"outside"))){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi))p.WaitForExit();
            Throws<UnauthorizedAccessException>(()=>DocQa.ReadVerified(Path.Combine(link,"secret.md"),rootFinal));
            string hard=Path.Combine(allowed,"hard.md");var psi2=new ProcessStartInfo("cmd.exe","/c mklink /H "+Common.Q(hard)+" "+Common.Q(Path.Combine(r,"outside","secret.md"))){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi2))p.WaitForExit();
            Check(File.Exists(hard),"fixture could not create hard link");
            Throws<UnauthorizedAccessException>(()=>DocQa.ReadVerified(hard,rootFinal));
            Directory.Delete(link);File.Delete(hard);
        });
        Test("oversized headings, lines and docx bombs stay bounded",()=>{
            var md=DocQa.FileToChunks(new UTF8Encoding(false).GetBytes("---\ndoc_id: X\n---\n# T\n\n## "+new string('標',5000)+"\n\n內容一\n\n內容二"),"x.md","x.md","x");
            Check(md.All(k=>((string)k["section"]).Length<=DocQa.MaxSectionChars)&&md.Count<=40,"markdown heading not capped: count="+md.Count);
            var txt=DocQa.FileToChunks(new UTF8Encoding(false).GetBytes(new string('字',100000)),"y.txt","y.txt","y");
            Check(txt.All(k=>((string)k["text"]).Length<=DocQa.MaxChars)&&txt.Count<=225,"long line not bounded: count="+txt.Count);
            byte[] bomb;using(var ms=new MemoryStream()){using(var z=new System.IO.Compression.ZipArchive(ms,System.IO.Compression.ZipArchiveMode.Create,true)){var e=z.CreateEntry("word/document.xml");using(var w=new StreamWriter(e.Open(),new UTF8Encoding(false))){var block=new string('a',1<<20);for(int i=0;i<21;i++)w.Write(block);}}bomb=ms.ToArray();}
            Check(bomb.Length<1024*1024,"bomb fixture should be small: "+bomb.Length);
            Throws<InvalidDataException>(()=>DocQa.FileToChunks(bomb,"z.docx","z.docx","z"));
        });
        Test("stale temp folders are cleaned by their name time and deletion never follows junctions",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed");writeRoots(r,allowed);
            string parent=Path.Combine(r,"doc-index");Directory.CreateDirectory(parent);
            string oldDir=Path.Combine(parent,"~old-20200101T000000Z-aaaaaaaa"),recent=Path.Combine(parent,"~tmp-"+DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'")+"-bbbbbbbb"),odd=Path.Combine(parent,"~old-garbage");
            foreach(var d in new[]{oldDir,recent,odd})Directory.CreateDirectory(d);
            string sentinel=Path.Combine(r,"sentinel");Directory.CreateDirectory(sentinel);File.WriteAllText(Path.Combine(sentinel,"keep.txt"),"keep");
            var psi=new ProcessStartInfo("cmd.exe","/c mklink /J "+Common.Q(Path.Combine(oldDir,"j"))+" "+Common.Q(sentinel)){UseShellExecute=false,CreateNoWindow=true};using(var p=Process.Start(psi))p.WaitForExit();
            string props=Common.Encode(new{model_path="C:/models/embed.gguf"});string emb=Common.Encode(new{data=new[]{new{index=0,embedding=new[]{1.0,0.0}},new{index=1,embedding=new[]{0.0,1.0}}}});
            HttpFixture(new[]{props,emb},new[]{200,200},url=>DocQa.RemoteIndexAt(r,idxJson("t5",allowed),url,5000));
            Check(!Directory.Exists(oldDir)&&Directory.Exists(recent)&&Directory.Exists(odd),"cleanup picked the wrong folders");
            Check(File.Exists(Path.Combine(sentinel,"keep.txt")),"deletion followed a junction");
        });
        Test("front-matter values are capped and a non-numeric level does not break precheck",()=>{
            var md=DocQa.FileToChunks(new UTF8Encoding(false).GetBytes("---\ndoc_id: X\ntitle: "+new string('題',5000)+"\nlevel: abc\n---\n# T\n\n## 一\n\n內容"),"x.md","x.md","x");
            var meta=(Dictionary<string,object>)md[0]["metadata"];
            Check(((string)meta["title"]).Length<=DocQa.MaxSectionChars&&(string)meta["level"]=="abc","front matter not capped: "+((string)meta["title"]).Length);
        });
        Test("remote doc-index refuses new indexes beyond the index-count limit",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed");writeRoots(r,allowed);Directory.CreateDirectory(Path.Combine(r,"doc-index","existing"));
            int saved=DocQa.MaxIndexes;DocQa.MaxIndexes=1;try{Throws<InvalidOperationException>(()=>DocQa.RemoteIndexAt(r,idxJson("another",allowed),"http://127.0.0.1:1",1000));}finally{DocQa.MaxIndexes=saved;}
            Check(!Directory.Exists(Path.Combine(r,"doc-index","another")),"index created beyond the limit");
        });
        Test("remote doc-index enforces the document count limit before any embedding",()=>{
            string r=docRoot(),allowed=Path.Combine(r,"allowed");writeRoots(r,allowed);
            int saved=DocQa.MaxIndexFiles;DocQa.MaxIndexFiles=1;try{Throws<InvalidDataException>(()=>DocQa.RemoteIndexAt(r,idxJson("t3",allowed),"http://127.0.0.1:1",1000));}finally{DocQa.MaxIndexFiles=saved;}
            Check(!Directory.Exists(Path.Combine(r,"doc-index","t3")),"index created despite limit");
        });
        Test("doc-index reads Big5 and UTF-8 text files",()=>{
            string dir=Path.Combine(work,"enc-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);string s="逾期未結案應於三日內處理。";
            File.WriteAllBytes(Path.Combine(dir,"big5.txt"),Encoding.GetEncoding(950).GetBytes(s));
            File.WriteAllBytes(Path.Combine(dir,"utf8.txt"),new UTF8Encoding(false).GetBytes(s));
            File.WriteAllText(Path.Combine(dir,"bom.md"),s,new UTF8Encoding(true));
            foreach(var f in new[]{"big5.txt","utf8.txt","bom.md"})Check(DocQa.ReadText(Path.Combine(dir,f))==s,f+" decoded wrong: "+DocQa.ReadText(Path.Combine(dir,f)));
        });
        Test("doc-qa grounding lists are bounded",()=>{
            string root=docQaRoot();
            string many=string.Join("，",Enumerable.Range(11,30).Select(i=>i+" 筆"))+" [T#01]。\nSTATUS: ANSWER";
            string chat=Common.Encode(new{choices=new[]{new{finish_reason="stop",message=new{content=many}}}});
            HttpFixture(new[]{embedResp,rerankResp,chat},new[]{200,200,200},url=>{
                string result=DocQa.ExecuteAt(root,docQaPrompt("逾期案件何時要處理？"),url,url,url,5000,5000,5000);
                Check(((object[])Common.Decode(result)["unsupported"]).Length==10&&result.Length<=3900,"grounding list not bounded: "+result);
            });
        });
        Console.WriteLine("RESULT passed="+passed+" failed="+failed+"; no database or external-network calls; curl and model HTTP used loopback fixtures only.");return failed==0?0:1;
    }
}
