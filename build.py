import re,sys
src=open('../clan2.html',encoding='utf-8').read()
shim=open('shim.js',encoding='utf-8').read()
# 1. SNAP off
src,n=re.subn(r'var SNAP = \{.*?\};\n','var SNAP = null;\n',src,count=1,flags=re.S); assert n==1
# 2. shim before app script
i=src.index('<script>\n(function () {\n  var HERO')
src=src[:i]+'<script src="/shim.js"></script>\n'+src[i:]
# 3. setup text
a=src.index('<h3>Who can do what</h3>'); b=src.index('</ol>',a)+5
new='''<h3>Who can do what</h3>
        <ol class="steps">
          <li><b>Everyone:</b> sees the roster, scrims and updates with no account. New people tap “Add me to the roster” and wait in Pending for a leader to approve.</li>
          <li><b>Leaders and Vice Masters:</b> log in with their personal code. They approve joins, edit and remove members, post updates and make scrims.</li>
          <li><b>Master:</b> can also give the Leader, Vice Master or Master role, and make codes for leaders.</li>
          <li><b>Login codes:</b> use “Login codes” below to make a code for a leader or any member, then send it on WhatsApp.</li>
        </ol>'''
src=src[:a]+new+src[b:]
open('public/index.html','w',encoding='utf-8').write(src)
open('public/shim.js','w',encoding='utf-8').write(shim)
