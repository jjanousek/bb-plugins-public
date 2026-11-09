---
name: faces
description: See or change the face the Faces plugin draws beside each thread in bb's sidebar, with the bb faces command. Use when someone asks for a different face for a thread, or to hide or show a thread's face.
---

# Faces

The Faces plugin draws a small face beside every thread in bb's sidebar. A thread gets its face the first time it shows there and keeps it. A face is a colour and a shape, such as "teal egg".

- `bb faces` lists each thread's face.
- `bb faces set <thread id> <colour> <shape>` gives a thread that face, for example `bb faces set thr_example1 teal egg`. Leave out the thread id to change the thread you are running in.
- `bb faces new [thread id]` gives a thread a different face.
- `bb faces hide [thread id]` takes the face away, and `bb faces show [thread id]` puts it back.
- `bb faces choices` lists the shapes and colours.

The person can also change a face from the thread's menu in the sidebar, under Face.
