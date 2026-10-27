using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using DbAgent;

public static class FixtureTests {
    static void Check(bool condition,string message) {if(!condition)throw new Exception(message);}
    static int[] Ids(Dictionary<string,object> report,string key) {return ((object[])report[key]).Select(x=>Convert.ToInt32(x)).ToArray();}
    static string Hash(string text) {using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(new UTF8Encoding(false).GetBytes(text))).Replace("-","");}
    static void WithRoot(string work,Action<string> run) {
        string root=Path.Combine(work,"fixture-test-"+Guid.NewGuid().ToString("N"));
        try {run(root);} finally {if(Directory.Exists(root))Directory.Delete(root,false);}
    }
    public static void Run(string work,Action<string,Action> test) {
        test("fixture clean write/read and owned cleanup",()=>WithRoot(work,root=>{
            string result=FixtureActions.ExecuteAt("fixture-roundtrip",root);var report=Common.Decode(result);
            Check(result.Length<=3000 && (string)report["kind"]=="synthetic_file_fixture","Report shape or size mismatch.");
            Check(Convert.ToInt32(report["source_count"])==8 && Convert.ToInt32(report["target_count"])==8,"Fixture counts mismatch.");
            Check(Convert.ToInt32(report["source_sum_cents"])==20000 && Convert.ToInt32(report["target_sum_cents"])==20000,"Fixture sums mismatch.");
            Check(Ids(report,"source_ids").SequenceEqual(new[]{1,2,3,4,5,6,7,8}) && Ids(report,"target_ids").SequenceEqual(new[]{1,2,3,4,5,6,7,8}),"Clean IDs mismatch.");
            string expected="id,amount_cents\r\n1,12525\r\n2,-5050\r\n3,0\r\n4,2525\r\n5,10000\r\n6,100\r\n7,-100\r\n8,0\r\n";
            Check((string)report["readback_sha256"]==Hash(expected),"Readback bytes mismatch.");
            Check((bool)report["cleanup_verified"] && Directory.GetFileSystemEntries(root).Length==0,"Owned fixture was not cleaned.");
            Check(Convert.ToInt64(report["elapsed_ms"])>=0,"Elapsed time missing.");
        }));
        test("fixture duplicate ID preserves counts and sums",()=>WithRoot(work,root=>{
            var report=Common.Decode(FixtureActions.ExecuteAt("fixture-break",root));
            Check(Convert.ToInt32(report["source_count"])==8 && Convert.ToInt32(report["target_count"])==8,"Break changed counts.");
            Check(Convert.ToInt32(report["source_sum_cents"])==20000 && Convert.ToInt32(report["target_sum_cents"])==20000,"Break changed sums.");
            Check(Ids(report,"source_ids").SequenceEqual(new[]{1,2,3,4,5,6,7,8}) && Ids(report,"target_ids").SequenceEqual(new[]{1,2,3,3,5,6,7,8}),"Expected duplicate ID not observed.");
            Check(!Ids(report,"source_ids").SequenceEqual(Ids(report,"target_ids")),"Independent ID reconciliation failed to detect break.");
            Check((bool)report["cleanup_verified"] && Directory.GetFileSystemEntries(root).Length==0,"Break fixture was not cleaned.");
        }));
        test("fixture invalid action has no filesystem effect",()=>WithRoot(work,root=>{
            bool rejected=false;try{FixtureActions.ExecuteAt("unknown",root);}catch(ArgumentException){rejected=true;}
            Check(rejected && !Directory.Exists(root) && !File.Exists(root),"Invalid action mutated the filesystem.");
        }));
    }
}
