using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace DbAgent {
public static class FixtureActions {
    public static string Execute(string action) { return ExecuteAt(action,@"C:\dbclone\dhc-agent-v1\fixtures"); }
    static void OrdinaryPath(string path) {
        for(string current=path;current!=null;current=Path.GetDirectoryName(current)) {
            if((Directory.Exists(current)||File.Exists(current)) && (File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)
                throw new IOException("Fixture path contains a reparse point.");
        }
    }
    internal static string ExecuteAt(string action,string root) {
        if(action!="fixture-roundtrip" && action!="fixture-break")throw new ArgumentException("Unknown fixture action.");
        if(string.IsNullOrWhiteSpace(root))throw new ArgumentException("Fixture root is required.");
        var elapsed=Stopwatch.StartNew();
        root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)+Path.DirectorySeparatorChar;
        OrdinaryPath(root.TrimEnd(Path.DirectorySeparatorChar));
        Directory.CreateDirectory(root);
        string owned=Path.GetFullPath(Path.Combine(root,Guid.NewGuid().ToString("N")));
        if(!owned.StartsWith(root,StringComparison.OrdinalIgnoreCase) || Directory.Exists(owned) || File.Exists(owned))
            throw new IOException("Fixture directory ownership could not be established.");
        string file=Path.Combine(owned,"rows.csv");
        int[] sourceIds={1,2,3,4,5,6,7,8};
        int[] amounts={12525,-5050,0,2525,10000,100,-100,0};
        var targetIds=new List<int>();var targetAmounts=new List<int>();
        string readbackHash=null;bool directoryCreated=false,fileCreated=false,cleanupVerified=false;
        try {
            Directory.CreateDirectory(owned);directoryCreated=true;OrdinaryPath(owned);
            var csv=new StringBuilder("id,amount_cents\r\n");
            for(int i=0;i<sourceIds.Length;i++) {
                int id=action=="fixture-break" && i==3?3:sourceIds[i];
                csv.Append(id.ToString(CultureInfo.InvariantCulture)).Append(',').Append(amounts[i].ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            }
            byte[] bytes=new UTF8Encoding(false,true).GetBytes(csv.ToString());
            using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                fileCreated=true;stream.Write(bytes,0,bytes.Length);stream.Flush(true);
            }
            OrdinaryPath(file);
            byte[] readback=File.ReadAllBytes(file);readbackHash=Common.Hash(readback);
            using(var reader=new StringReader(new UTF8Encoding(false,true).GetString(readback))) {
                if(reader.ReadLine()!="id,amount_cents")throw new InvalidDataException("Unexpected fixture header.");
                string line;while((line=reader.ReadLine())!=null) {
                    string[] fields=line.Split(',');
                    if(fields.Length!=2 || targetIds.Count>=8)throw new InvalidDataException("Unexpected fixture row structure.");
                    targetIds.Add(int.Parse(fields[0],NumberStyles.Integer,CultureInfo.InvariantCulture));
                    targetAmounts.Add(int.Parse(fields[1],NumberStyles.Integer,CultureInfo.InvariantCulture));
                }
            }
        } finally {
            if(fileCreated && File.Exists(file)) {OrdinaryPath(file);File.Delete(file);}
            if(directoryCreated && Directory.Exists(owned)) {OrdinaryPath(owned);Directory.Delete(owned,false);}
            cleanupVerified=directoryCreated && !File.Exists(file) && !Directory.Exists(owned);
        }
        string result=Common.Encode(new {kind="synthetic_file_fixture",source_count=sourceIds.Length,target_count=targetIds.Count,
            source_sum_cents=amounts.Sum(),target_sum_cents=targetAmounts.Sum(),source_ids=sourceIds,target_ids=targetIds.ToArray(),
            readback_sha256=readbackHash,cleanup_verified=cleanupVerified,elapsed_ms=elapsed.ElapsedMilliseconds});
        if(result.Length>3000)throw new InvalidDataException("Fixture report exceeded the output budget.");
        return result;
    }
}
}
