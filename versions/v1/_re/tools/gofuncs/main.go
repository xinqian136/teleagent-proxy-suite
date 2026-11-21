// gofuncs — 用官方 debug/gosym 解析 Go PE 二进制的函数表（名 + 入口 VA）。
//
// 用法: gofuncs <exe> [名称过滤正则]
package main

import (
	"debug/gosym"
	"debug/pe"
	"encoding/binary"
	"fmt"
	"os"
	"regexp"
	"sort"
)

type sym struct {
	addr uint64
	name string
}

// findPclntab 在 .rdata 中找 pclntab（Go 1.20+ magic 0xFFFFFFF1 等）
func findPclntab(data []byte) (int64, bool) {
	magics := []uint32{0xFFFFFFF1, 0xFFFFFFF0, 0xFFFFFFFA, 0xFFFFFFFB}
	for _, m := range magics {
		pat := make([]byte, 4)
		binary.LittleEndian.PutUint32(pat, m)
		for i := 0; i+8 <= len(data); i++ {
			if binary.LittleEndian.Uint32(data[i:]) != m {
				continue
			}
			pad := binary.LittleEndian.Uint16(data[i+4:])
			minLC := data[i+6]
			ptrSize := data[i+7]
			if pad == 0 && minLC == 1 && (ptrSize == 4 || ptrSize == 8) {
				return int64(i), true
			}
		}
	}
	return 0, false
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: gofuncs <exe> [regex]")
		os.Exit(2)
	}
	path := os.Args[1]

	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()

	pef, err := pe.NewFile(f)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	oh := pef.OptionalHeader.(*pe.OptionalHeader64)
	imageBase := oh.ImageBase

	var textVA uint64
	var rdata []byte
	for _, s := range pef.Sections {
		switch s.Name {
		case ".text":
			textVA = imageBase + uint64(s.VirtualAddress)
		case ".rdata":
			rdata, _ = s.Data()
		}
	}
	if len(rdata) == 0 {
		fmt.Fprintln(os.Stderr, "no .rdata")
		os.Exit(1)
	}

	off, ok := findPclntab(rdata)
	if !ok {
		fmt.Fprintln(os.Stderr, "pclntab not found")
		os.Exit(1)
	}
	pcln := rdata[off:]
	fmt.Printf("[+] pclntab at rdata+0x%x  textVA=0x%x  imageBase=0x%x\n", off, textVA, imageBase)

	// Go PE: textStart 取 .text 段 VA
	lineTab := gosym.NewLineTable(pcln, textVA)
	tab, err := gosym.NewTable(nil, lineTab)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gosym: %v\n", err)
		os.Exit(1)
	}

	var syms []sym
	for _, fn := range tab.Funcs {
		syms = append(syms, sym{addr: fn.Entry, name: fn.Name})
	}
	sort.Slice(syms, func(i, j int) bool { return syms[i].addr < syms[j].addr })
	fmt.Printf("[+] parsed %d funcs\n", len(syms))

	if len(os.Args) > 2 {
		re, err := regexp.Compile(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, s := range syms {
			if re.MatchString(s.name) {
				fmt.Printf("0x%x\t%s\n", s.addr, s.name)
			}
		}
		return
	}
	for i, s := range syms {
		if i > 40 {
			break
		}
		fmt.Printf("0x%x\t%s\n", s.addr, s.name)
	}
}
