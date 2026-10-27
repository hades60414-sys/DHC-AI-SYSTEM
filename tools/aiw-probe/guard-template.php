<?php /*aiw-guard*/ if (time() - filemtime(__FILE__) > 1800) { http_response_code(410); exit('aiw test page expired'); } ?>
<?php
// Test page body goes below the guard line. Read-only: no writes to databases or files.
echo 'aiw-probe ok ' . date('Y-m-d H:i:s');
